import { readdir, readFile } from 'node:fs/promises'
import postgres from 'postgres'

export type Sql = postgres.Sql

/**
 * The schema every bridge table lives in. The bridge normally shares a database
 * with Evolution (on Railway, one Postgres service), and keeps out of `public`.
 * The app names the same schema in `server/utils/telegram-db.ts`; keep the two in
 * step.
 */
export const BRIDGE_SCHEMA = 'telegram'

const MIGRATIONS = new URL('./migrations/', import.meta.url)
/** Serialises migrations across processes starting at once. */
const MIGRATE_LOCK = '7340031542916270001'

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // A RAISE NOTICE can carry row data; the process log is not where that goes.
    onnotice: () => {},
    // search_path is set on these connections, never on the database role: the
    // role is usually the one Evolution connects as, and a role default would
    // redirect its queries too. `public` stays second only so an extension
    // installed there (pg_trgm) still resolves; no bridge table is created in
    // it — see ensureBridgeSchema.
    connection: {
      application_name: 'telegram-bridge',
      statement_timeout: 15_000,
      search_path: `${BRIDGE_SCHEMA}, public`,
    },
  })
}

/**
 * Make the bridge's schema exist, and prove unqualified names resolve into it.
 *
 * Every bridge query and migration names its tables without a schema and finds
 * them through this connection's search_path. If that setting did not take — a
 * connection pooler dropping startup parameters, say — the current schema would
 * be `public`, and the first migration would create every table beside
 * Evolution's. So this is checked, not assumed.
 *
 * Existence is tested before creating because `CREATE SCHEMA IF NOT EXISTS`
 * still demands CREATE on the database, which a restricted role may lack even
 * when the schema is already there.
 */
export async function ensureBridgeSchema(sql: Sql): Promise<void> {
  const [existing] = await sql`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${BRIDGE_SCHEMA}`
  if (!existing) await sql`CREATE SCHEMA IF NOT EXISTS ${sql(BRIDGE_SCHEMA)}`

  const [row] = await sql<{ schema: string | null }[]>`SELECT current_schema() AS schema`
  if (row?.schema !== BRIDGE_SCHEMA) {
    throw new Error(
      `telegram-bridge cannot start: its connection resolves names in schema ${row?.schema ?? '(none)'} rather than `
      + `${BRIDGE_SCHEMA}, so its tables would be created beside Evolution's. Something between the bridge and `
      + 'Postgres is overriding search_path.',
    )
  }
}

/**
 * Apply every migration not yet recorded, in filename order, in one transaction.
 *
 * The files are this service's own SQL, so running them through `unsafe` (the
 * simple protocol, several statements per file) is the intent rather than a
 * risk: nothing in them comes from a request.
 */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await readdir(MIGRATIONS)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()

  return await sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = 0`
    await tx`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK}::bigint)`
    await tx`CREATE TABLE IF NOT EXISTS bridge_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`

    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM bridge_migrations`).map(row => row.name))
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      await tx.unsafe(await readFile(new URL(file, MIGRATIONS), 'utf8'))
      await tx`INSERT INTO bridge_migrations (name) VALUES (${file})`
      applied.push(file)
    }
    return applied
  })
}

/**
 * What an optional reader role for the app may see (`TELEGRAM_READER_ROLE`):
 * synced messages, and the chat and user directories **minus** `access_hash` and
 * `phone`. Unused when the app reads with the bridge's own credential.
 *
 * An explicit column allowlist, not "every column except": a column added later
 * stays invisible to the reader until someone decides here that it should not be.
 * `sessions` holds sealed Telegram sessions and webhook headers and is never
 * granted.
 */
const READER_COLUMNS = {
  chats: [
    'session_id', 'chat_id', 'type', 'title', 'username', 'is_forum', 'participant_count',
    'top_message_id', 'last_message_at', 'unread_count', 'migrated_to', 'backfill_complete',
    'backfill_stopped', 'oldest_synced_at', 'gap_since', 'archived', 'updated_at',
  ],
  users: ['session_id', 'user_id', 'first_name', 'last_name', 'username', 'is_bot', 'updated_at'],
}

/**
 * Re-assert the reader's grants on every boot, so they converge on the list
 * above rather than accumulating whatever an older build granted.
 *
 * Answers false when the role does not exist yet — a bridge can run before the
 * app is set up to read, and that is not a reason to refuse to start.
 */
export async function grantReader(sql: Sql, role: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean, is_self: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS exists,
           ${role} = current_user AS is_self`
  if (!row?.exists) return false
  // Revoking "all" from the owner would revoke the bridge's own access.
  if (row.is_self) throw new Error(`TELEGRAM_READER_ROLE is the bridge's own role (${role}); it must be a separate, SELECT-only role`)

  await sql.begin(async (tx) => {
    await tx`REVOKE ALL ON ALL TABLES IN SCHEMA ${tx(BRIDGE_SCHEMA)} FROM ${tx(role)}`
    await tx`GRANT USAGE ON SCHEMA ${tx(BRIDGE_SCHEMA)} TO ${tx(role)}`
    await tx`GRANT SELECT ON messages TO ${tx(role)}`
    await tx`GRANT SELECT (${tx(READER_COLUMNS.chats)}) ON chats TO ${tx(role)}`
    await tx`GRANT SELECT (${tx(READER_COLUMNS.users)}) ON users TO ${tx(role)}`
  })
  return true
}
