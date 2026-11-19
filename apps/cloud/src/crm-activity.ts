import { BrevoError, type Crm, type Upserted } from './crm.ts'
import type { Sql } from './db.ts'

/**
 * The daily activity-date pass: once per UTC day, bring every contact's
 * `LAST_MCP_USE` / `ORG_LAST_MCP_USE` into line with `app.mcp_tokens`.
 *
 * Not outbox-driven on purpose. A call writes `last_used_at` and no event —
 * an event per call is what `usage.rollup` exists to avoid — and turning
 * Telemetry off writes no event either. Comparing the live (Telemetry-gated)
 * dates with what was last sent (`cloud.crm_last_use`) catches both, and only
 * users whose date moved cost a Brevo call. The dates are days, so a daily
 * pass loses nothing.
 *
 * Contacts go through the same `upsertOrSkip` as outbox events, so the pass
 * creates a missing contact, sends the whole current state, and sorts Brevo's
 * failures the same way: a pause or wrong key ends the run without marking the
 * day done (the next tick resumes, and users already sent are no longer
 * different); a refusal goes to `cloud.crm_skipped` and the user is retried
 * the next day.
 */

const JOB = 'crm_activity'
/** A lease outlasting a crashed run by this much at most; renewed per chunk. */
const LEASE_MS = 30 * 60_000
const CHUNK = 200

/** Run the pass if today's has not finished and no other replica holds it. Answers contacts sent. */
export async function syncActivityDates(sql: Sql, crm: Crm): Promise<number> {
  if (!crm.configured || crm.paused || !await crm.prepare()) return 0
  if (!await claim(sql)) return 0

  const counts: Record<Upserted | 'skipped', number> = { created: 0, claimed: 0, updated: 0, skipped: 0 }
  let finished = false
  try {
    const ids = await crm.activityChanged()
    finished = true
    for (let start = 0; start < ids.length && finished; start += CHUNK) {
      await renew(sql)
      const users = await crm.loadUsers(ids.slice(start, start + CHUNK))
      for (const user of users.values()) {
        try {
          counts[await crm.upsertOrSkip(user)]++
        }
        catch (error) {
          if (!(error instanceof BrevoError)) throw error
          crm.pauseFor(error)
          finished = false
          break
        }
      }
    }
  }
  finally {
    await release(sql, finished)
  }

  const sent = counts.created + counts.claimed + counts.updated
  if (sent || counts.skipped) {
    console.info(`[crm] activity dates: ${counts.updated} updated, ${counts.created} created, ${counts.claimed} claimed, ${counts.skipped} skipped${finished ? '' : '; paused, resuming on a later tick'}`)
  }
  return sent
}

async function claim(sql: Sql): Promise<boolean> {
  const rows = await sql`
    INSERT INTO cloud.daily_jobs AS j (job, lease_until)
    VALUES (${JOB}, now() + ${LEASE_MS} * interval '1 millisecond')
    ON CONFLICT (job) DO UPDATE SET lease_until = EXCLUDED.lease_until
    WHERE j.lease_until < now()
      AND (j.done_day IS NULL OR j.done_day < (now() AT TIME ZONE 'UTC')::date)
    RETURNING job
  `
  return rows.length > 0
}

async function renew(sql: Sql): Promise<void> {
  await sql`
    UPDATE cloud.daily_jobs SET lease_until = now() + ${LEASE_MS} * interval '1 millisecond'
    WHERE job = ${JOB}
  `
}

async function release(sql: Sql, finished: boolean): Promise<void> {
  await sql`
    UPDATE cloud.daily_jobs SET
      lease_until = now(),
      done_day    = CASE WHEN ${finished} THEN (now() AT TIME ZONE 'UTC')::date ELSE done_day END
    WHERE job = ${JOB}
  `
}
