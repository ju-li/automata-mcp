import type { Sql } from './db.ts'

/**
 * The daily revenue snapshot: one `cloud.revenue_daily` row per Eastern-time
 * day, computed from `cloud.stripe_subscriptions` — no Stripe call of its own.
 * Stripe has no API for historical MRR, so these rows are the history.
 *
 * Day `d`'s row describes the subscriptions at the end of `d` (midnight
 * Eastern), and is written once a Stripe reconcile has finished after that
 * moment, so every row it reads is no older than the end of the day. The
 * reconcile runs hourly, so yesterday's row lands within about an hour of
 * midnight. Same lease and finished-day pattern as the CRM activity pass
 * (`cloud.daily_jobs`), so replicas compute it once.
 *
 * Any day without a row before the one being written — the first run, or days
 * the service was down — is reconstructed from subscription dates and marked
 * `backfilled`. Those use each subscription's *current* price and discount
 * and cannot know which subscriptions were past due (`past_due` NULL).
 *
 * Definitions, all at the end of the day unless "today":
 * - paying: started, past any trial, not ended, not `incomplete*`; a
 *   subscription still running counts only while `active` or `past_due`.
 *   `paying` counts those whose discounted amount is above zero (so 100%-off
 *   comps are left out); `mrr_cents` sums them all, normalized to a month.
 * - trialing: inside `trial_start … trial_end`, not ended.
 * - canceled_today: ended today after having paid. trials_canceled_today:
 *   ended today without ever leaving the trial.
 * - trials_converted_today: trial ended today and the subscription went on.
 *
 * Amounts are summed across currencies as they are; everything is sold in one.
 */

const JOB = 'revenue_daily'
/** The reconcile pass's row in `cloud.job_runs`, written by `markReconciled`. */
const RECONCILE_JOB = 'stripe_reconcile'
const TIME_ZONE = 'America/New_York'
const LEASE_MS = 10 * 60_000

/** Write yesterday's row (and any missing before it) if due. Answers rows written. */
export async function snapshotRevenue(sql: Sql): Promise<number> {
  if (!await claim(sql)) return 0
  let written = 0
  let finished = false
  try {
    written = await writeDays(sql)
    finished = true
  }
  finally {
    await release(sql, finished)
  }
  if (written) console.info(`[revenue] wrote ${written} day(s) of cloud.revenue_daily`)
  return written
}

/** Record that a whole reconcile pass finished now. */
export async function markReconciled(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO cloud.job_runs (job, finished_at) VALUES (${RECONCILE_JOB}, now())
    ON CONFLICT (job) DO UPDATE SET finished_at = EXCLUDED.finished_at
  `
}

/**
 * Claimed only when yesterday (Eastern) has no finished run and a reconcile
 * has finished since yesterday ended. `done_day` = the last day written.
 */
async function claim(sql: Sql): Promise<boolean> {
  const rows = await sql`
    WITH target AS (
      SELECT (now() AT TIME ZONE ${TIME_ZONE})::date - 1 AS day
    )
    INSERT INTO cloud.daily_jobs AS j (job, lease_until)
    SELECT ${JOB}, now() + ${LEASE_MS} * interval '1 millisecond'
    FROM target
    WHERE EXISTS (
      SELECT 1 FROM cloud.job_runs r
      WHERE r.job = ${RECONCILE_JOB}
        AND r.finished_at >= ((target.day + 1)::timestamp AT TIME ZONE ${TIME_ZONE})
    )
    ON CONFLICT (job) DO UPDATE SET lease_until = EXCLUDED.lease_until
    WHERE j.lease_until < now()
      AND (j.done_day IS NULL OR j.done_day < (now() AT TIME ZONE ${TIME_ZONE})::date - 1)
    RETURNING job
  `
  return rows.length > 0
}

async function release(sql: Sql, finished: boolean): Promise<void> {
  await sql`
    UPDATE cloud.daily_jobs SET
      lease_until = now(),
      done_day    = CASE WHEN ${finished} THEN (now() AT TIME ZONE ${TIME_ZONE})::date - 1 ELSE done_day END
    WHERE job = ${JOB}
  `
}

/**
 * One statement: yesterday's row (replaced if already there) plus every
 * missing day from the first stored day — or the first subscription's start,
 * on the first run — as backfilled rows. Each day is evaluated at its end
 * (`t`), with `t0` its start.
 */
async function writeDays(sql: Sql): Promise<number> {
  const rows = await sql`
    WITH target AS (
      SELECT (now() AT TIME ZONE ${TIME_ZONE})::date - 1 AS day
    ),
    bounds AS (
      SELECT least(
        target.day,
        coalesce(
          (SELECT min(day) FROM cloud.revenue_daily),
          (SELECT min((start_date AT TIME ZONE ${TIME_ZONE})::date) FROM cloud.stripe_subscriptions),
          target.day
        )
      ) AS first, target.day AS last
      FROM target
    ),
    days AS (
      SELECT g::date AS day,
             g::date = bounds.last AS live,
             ((g::date)::timestamp AT TIME ZONE ${TIME_ZONE}) AS t0,
             ((g::date + 1)::timestamp AT TIME ZONE ${TIME_ZONE}) AS t
      FROM bounds, generate_series(bounds.first::timestamp, bounds.last::timestamp, interval '1 day') g
      WHERE g::date = bounds.last
         OR NOT EXISTS (SELECT 1 FROM cloud.revenue_daily r WHERE r.day = g::date)
    ),
    subs AS (
      SELECT d.day, d.live, d.t0, d.t, s.*,
        -- Discounted amount for one billing period at t, never below zero.
        greatest(0,
          s.period_amount
            * (1 - CASE WHEN active_discount THEN coalesce(s.percent_off, 0) ELSE 0 END / 100)
            - CASE WHEN active_discount THEN coalesce(s.amount_off, 0) ELSE 0 END
        ) AS net_period,
        CASE s."interval"
          WHEN 'month' THEN 1.0 / s.interval_count
          WHEN 'year'  THEN 1.0 / (12 * s.interval_count)
          WHEN 'week'  THEN 52.0 / 12 / s.interval_count
          WHEN 'day'   THEN 365.0 / 12 / s.interval_count
          ELSE 0
        END AS per_month,
        s.status NOT IN ('incomplete', 'incomplete_expired')
          AND s.start_date <= d.t
          AND coalesce(s.trial_end, s.start_date) <= d.t
          AND (s.ended_at > d.t OR (s.ended_at IS NULL AND s.status IN ('active', 'past_due')))
          AS paying,
        s.trial_start <= d.t AND s.trial_end > d.t
          AND (s.ended_at IS NULL OR s.ended_at > d.t)
          AS trialing
      FROM days d
      CROSS JOIN cloud.stripe_subscriptions s
      CROSS JOIN LATERAL (
        SELECT s.coupon_id IS NOT NULL
           AND s.discount_start <= d.t
           AND (s.discount_end IS NULL OR s.discount_end > d.t) AS active_discount
      ) disc
    )
    INSERT INTO cloud.revenue_daily AS r (
      day, mrr_cents, paying, trialing, past_due, canceled_today,
      trials_canceled_today, trials_converted_today, backfilled, computed_at
    )
    SELECT d.day,
      coalesce(round(sum(s.net_period * s.per_month) FILTER (WHERE s.paying)), 0)::bigint,
      count(*) FILTER (WHERE s.paying AND s.net_period > 0),
      count(*) FILTER (WHERE s.trialing),
      CASE WHEN d.live THEN count(*) FILTER (WHERE s.status = 'past_due' AND s.ended_at IS NULL) END,
      count(*) FILTER (WHERE s.ended_at >= d.t0 AND s.ended_at < d.t
                         AND s.status NOT IN ('incomplete', 'incomplete_expired')
                         AND s.ended_at > coalesce(s.trial_end, s.start_date)),
      count(*) FILTER (WHERE s.ended_at >= d.t0 AND s.ended_at < d.t
                         AND s.trial_end IS NOT NULL AND s.ended_at <= s.trial_end),
      count(*) FILTER (WHERE s.trial_end >= d.t0 AND s.trial_end < d.t
                         AND s.status NOT IN ('trialing', 'incomplete', 'incomplete_expired')
                         AND (s.ended_at IS NULL OR s.ended_at > s.trial_end)),
      NOT d.live,
      now()
    FROM days d
    LEFT JOIN subs s ON s.day = d.day
    GROUP BY d.day, d.live
    ON CONFLICT (day) DO UPDATE SET
      mrr_cents              = EXCLUDED.mrr_cents,
      paying                 = EXCLUDED.paying,
      trialing               = EXCLUDED.trialing,
      past_due               = EXCLUDED.past_due,
      canceled_today         = EXCLUDED.canceled_today,
      trials_canceled_today  = EXCLUDED.trials_canceled_today,
      trials_converted_today = EXCLUDED.trials_converted_today,
      backfilled             = EXCLUDED.backfilled,
      computed_at            = EXCLUDED.computed_at
    RETURNING day
  `
  return rows.length
}
