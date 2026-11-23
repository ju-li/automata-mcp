import postgres from 'postgres'

export type Sql = postgres.Sql
export type Db = postgres.Sql | postgres.TransactionSql

/**
 * The cloud service's database access.
 *
 * It connects to the web app's database and works across two schemas, naming
 * both on every query rather than relying on search_path:
 *
 *   app     owned by the web app's migrations. This service reads it, writes
 *           only an organization's billing and entitlement columns, and appends
 *           `plan.changed` to `app.hosted_events`. It never touches `instances`
 *           credentials.
 *   cloud   this service's own state — consumer cursors on the event outbox,
 *           CRM updates Brevo refused for good, the activity dates each
 *           contact last received, daily job leases, the self-hosters who
 *           asked for update mail, every Stripe subscription read and the
 *           daily revenue snapshot. Created here at boot.
 */
export const CLOUD_SCHEMA = 'cloud'

/**
 * The web app migration this service needs: the newest one whose columns it
 * writes — `0022` adds `recent_history_only`, on top of `0013`'s
 * `tool_calls_required` and `0007`'s entitlement columns, outbox and
 * `app.entitlement_defaults`. Migrations apply in order, so waiting for the
 * newest covers the rest. The service waits rather than failing, since the two
 * are deployed together and either may start first.
 */
const REQUIRED_APP_MIGRATION = '0022_recent_history_only'

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    // A RAISE NOTICE can carry row data; the process log is not where that goes.
    onnotice: () => {},
    // NULL reads as undefined and timestamps as ISO strings, exactly like the
    // web app's pool, so a row means the same thing on both sides.
    transform: {
      undefined: null,
      value: {
        from: (value: unknown) => value === null ? undefined : value instanceof Date ? value.toISOString() : value,
      },
    },
    connection: {
      application_name: 'automata-cloud',
      statement_timeout: 15_000,
    },
  })
}

/**
 * Create this service's schema and tables. Idempotent; runs at every boot.
 * Existence is tested before creating because `CREATE SCHEMA IF NOT EXISTS`
 * still demands CREATE on the database, which a restricted role may lack even
 * when the schema is already there.
 */
export async function ensureCloudSchema(sql: Sql): Promise<void> {
  const [existing] = await sql`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${CLOUD_SCHEMA}`
  if (!existing) await sql`CREATE SCHEMA IF NOT EXISTS ${sql(CLOUD_SCHEMA)}`

  // How far each consumer has read `app.hosted_events`. One row per consumer, so
  // a consumer added later (CRM, telemetry) starts from the beginning of the
  // retained backlog while the existing ones carry on where they were.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.cursors (
      consumer text PRIMARY KEY,
      last_id  bigint NOT NULL,
      updated  timestamptz NOT NULL DEFAULT now()
    )
  `

  // Contact updates Brevo refused for a reason retrying will not fix (an
  // address it calls invalid, say). Kept so they can be replayed by hand once
  // the cause is fixed — see "CRM (Brevo)" in docs/billing.md. event_id is
  // NULL for a refusal during the one-off backfill. Never holds the address.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.crm_skipped (
      id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id bigint,
      user_id  text NOT NULL,
      status   integer NOT NULL,
      code     text,
      at       timestamptz NOT NULL DEFAULT now()
    )
  `

  // The activity dates (last MCP call, the user's and their organization's)
  // each contact last received, so the daily pass sends only what changed —
  // including a clear when Telemetry was turned off. `YYYY-MM-DD` text, NULL =
  // nothing sent (or cleared). A missing row = never sent.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.crm_last_use (
      user_id          text PRIMARY KEY,
      last_mcp_use     text,
      org_last_mcp_use text,
      sent_at          timestamptz NOT NULL DEFAULT now()
    )
  `

  // Daily jobs: the UTC day each last finished, and a lease so only one
  // replica runs a job at a time. Claimed by conditional UPDATE, like the web
  // app's leases, so no connection is held for the length of a run.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.daily_jobs (
      job         text PRIMARY KEY,
      done_day    date,
      lease_until timestamptz NOT NULL DEFAULT '-infinity'
    )
  `

  // Self-hosters who asked their install for update mail (breaking changes,
  // security advisories) — self-host-updates.ts. Keyed on the lower-cased
  // address; `synced_at` NULL = not on the Brevo list yet, `refused_at` = Brevo
  // refused it for good (an address it calls invalid). `version` = the
  // install's version at signup, so an advisory can be aimed at who runs it.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.self_host_subscribers (
      email     text PRIMARY KEY,
      version   text,
      created   timestamptz NOT NULL DEFAULT now(),
      updated   timestamptz NOT NULL DEFAULT now(),
      synced_at timestamptz,
      refused_at timestamptz
    )
  `
  // Double opt-in: when the last confirmation email was asked of Brevo. Claimed
  // before the call, so an address gets at most one a day however often it is
  // submitted. `synced_at` then means "Brevo accepted the request", not "on the
  // list": only the click puts it there.
  await sql`ALTER TABLE cloud.self_host_subscribers ADD COLUMN IF NOT EXISTS doi_sent_at timestamptz`

  // Every Stripe subscription `syncOrg` has read (billing.ts), upserted on
  // each read: webhook and hourly reconcile. Never deleted — a canceled
  // subscription is what trial conversion and churn are counted from. No FK
  // to app.organizations: the row outlives a deleted organization. Holds no
  // address or name; join through app.organizations / app.users for those.
  // Amounts are Stripe's minor units (cents). `period_amount` = every item's
  // unit_amount × quantity for one billing period, before discounts; the
  // discount columns describe the subscription-level discount (Stripe allows
  // several; only the first is stored, the sync logs when there are more).
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.stripe_subscriptions (
      id                 text PRIMARY KEY,
      customer_id        text NOT NULL,
      organization_id    text,
      status             text NOT NULL,
      created            timestamptz NOT NULL,
      start_date         timestamptz NOT NULL,
      trial_start        timestamptz,
      trial_end          timestamptz,
      cancel_at          timestamptz,
      canceled_at        timestamptz,
      ended_at           timestamptz,
      current_period_end timestamptz,
      currency           text NOT NULL,
      "interval"         text NOT NULL,
      interval_count     integer NOT NULL,
      base_price_id      text,
      base_unit_amount   bigint,
      seat_price_id      text,
      seat_unit_amount   bigint,
      seat_quantity      integer NOT NULL DEFAULT 0,
      period_amount      bigint NOT NULL,
      items              jsonb NOT NULL,
      coupon_id          text,
      percent_off        numeric,
      amount_off         bigint,
      discount_start     timestamptz,
      discount_end       timestamptz,
      updated_at         timestamptz NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_idx ON cloud.stripe_subscriptions (customer_id)`

  // One row per Eastern-time day, from cloud.stripe_subscriptions (revenue.ts).
  // `backfilled` rows were reconstructed from subscription dates once, when the
  // table was first filled: past_due is unknown for them (NULL), and they use
  // each subscription's current price and discount.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.revenue_daily (
      day                    date PRIMARY KEY,
      mrr_cents              bigint NOT NULL,
      paying                 integer NOT NULL,
      trialing               integer NOT NULL,
      past_due               integer,
      canceled_today         integer NOT NULL,
      trials_canceled_today  integer NOT NULL,
      trials_converted_today integer NOT NULL,
      backfilled             boolean NOT NULL DEFAULT false,
      computed_at            timestamptz NOT NULL DEFAULT now()
    )
  `

  // When a recurring job last finished a whole pass. The revenue snapshot for
  // a day waits for a Stripe reconcile that finished after the day ended, so
  // every subscription row it reads is at least that fresh.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.job_runs (
      job         text PRIMARY KEY,
      finished_at timestamptz NOT NULL
    )
  `
}

/**
 * Resolve once the web app has migrated far enough for this service. Polls
 * rather than failing: deployed together, either may start first.
 */
export async function waitForApp(sql: Sql, signal: { stopped: boolean }): Promise<void> {
  let announced = false
  while (!signal.stopped) {
    try {
      const [row] = await sql`SELECT 1 FROM app.migrations WHERE name = ${REQUIRED_APP_MIGRATION}`
      if (row) return
    }
    catch {
      // The app schema does not exist yet.
    }
    if (!announced) {
      announced = true
      console.info(`[db] waiting for the web app to apply migration ${REQUIRED_APP_MIGRATION}`)
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
}
