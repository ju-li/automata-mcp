import type { Sql } from 'postgres'
import type { Db } from './app-db'

/**
 * The one-time move off PocketBase.
 *
 * Runs at boot, inside `appDb()`'s preparation, and only when both hold:
 * `NUXT_POCKETBASE_URL` is set, and `app.users` is empty. So it runs exactly once
 * per deployment — the moment it has written a user, the second condition is
 * false forever — and a fresh deployment that never had PocketBase never runs it.
 *
 * Everything comes across with its id, so URLs, token labels and the browser's
 * history keep working: users (with their bcrypt password hashes, which
 * `account.ts` still verifies and upgrades to scrypt on next sign-in),
 * organizations, memberships, connections with their credentials, assignments,
 * invitations, and connector tokens (only their SHA-256 hashes ever existed, so
 * every connector configured in Claude keeps working). Browser sessions do not
 * come across — PocketBase's were JWTs — so everyone signs in once.
 *
 * One transaction, under the same advisory lock as the migrations: it lands
 * whole or not at all, and two replicas booting together cannot both import.
 * Until it has landed, `appDb()` keeps failing, so every request answers 503
 * rather than letting someone sign up into an empty database and switch the
 * import off by doing so.
 *
 * Rows that point at something that no longer exists are skipped and counted
 * rather than failing the whole import: PocketBase enforced most of its
 * relations, but not `created_by`, and a stray row should not block a move.
 */

const IMPORT_LOCK = '7204118533901245'

/** Every column the export carries, across all tables. Each table has some of them. */
const COLUMNS = [
  'id', 'email', 'password', 'name', 'created', 'org', 'user', 'role', 'created_by', 'kind',
  'instance_id', 'api_key', 'admin_key', 'base_url', 'evolution_db_url', 'telegram_db_url', 'dsn',
  'db_host', 'db_port', 'db_database', 'label', 'down_since', 'alerted_at', 'instance',
  'code_hash', 'invited_by', 'accepted_by', 'expires_at', 'accepted_at', 'revoked',
  'assigned_to', 'token_hash', 'last_used_at', 'all_chats', 'chat_jids', 'all_tables',
  'table_names', 'all_tools', 'tool_names',
] as const

type Column = (typeof COLUMNS)[number]

/** One exported row, with any column its table lacks filled in as `''`. Every column is text. */
type Raw = Record<Column, string>


interface Export {
  users: Raw[]
  organizations: Raw[]
  memberships: Raw[]
  instances: Raw[]
  instance_assignments: Raw[]
  invitations: Raw[]
  mcp_tokens: Raw[]
}

export async function maybeImportFromPocketBase(sql: Sql): Promise<void> {
  const config = useRuntimeConfig()
  if (!config.pocketbaseUrl) return

  const [anyone] = await sql`SELECT 1 FROM app.users LIMIT 1`
  if (anyone) return

  console.log(`[import] app database is empty and NUXT_POCKETBASE_URL is set; importing from ${config.pocketbaseUrl}`)
  const data = await fetchExport(config.pocketbaseUrl, config.pocketbaseAdminEmail, config.pocketbaseAdminPassword)

  const counts = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${IMPORT_LOCK}::bigint)`
    const [raced] = await tx`SELECT 1 FROM app.users LIMIT 1`
    if (raced) return undefined
    return await importRows(tx, data)
  })

  if (counts) console.log(`[import] done: ${counts}`)
}

async function fetchExport(base: string, email: string, password: string): Promise<Export> {
  const url = base.replace(/\/+$/, '')
  if (!email || !password) {
    throw new Error('NUXT_POCKETBASE_ADMIN_EMAIL / NUXT_POCKETBASE_ADMIN_PASSWORD are needed to import from PocketBase')
  }

  const auth = await $fetch<{ token: string }>(`${url}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    body: { identity: email, password },
  })

  const data = await $fetch<Record<string, unknown>>(`${url}/api/app/export`, {
    headers: { Authorization: auth.token },
  }).catch((error) => {
    throw new Error(
      'PocketBase did not answer /api/app/export. The PocketBase image must include '
      + 'services/pocketbase/pb_hooks/export.pb.js — redeploy it from this commit first.',
      { cause: error },
    )
  })

  const filled = {} as Export
  for (const table of ['users', 'organizations', 'memberships', 'instances', 'instance_assignments', 'invitations', 'mcp_tokens'] as const) {
    const rows: unknown = data[table]
    if (!Array.isArray(rows)) throw new Error(`PocketBase export is missing ${table}`)
    filled[table] = rows.map((row: Partial<Raw>) => {
      const out = {} as Raw
      for (const column of COLUMNS) out[column] = typeof row[column] === 'string' ? row[column] : ''
      return out
    })
  }
  return filled
}

/** PocketBase writes `2026-09-12 10:00:00.000Z`, and `''` for an unset date. */
function date(value: string | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value.replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function bool(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/**
 * A JSON list column. Anything that is not a list of strings becomes `[]`.
 * Returned as an array, not text: postgres.js serialises by the column's type,
 * and a string would land in `jsonb` as a JSON string.
 */
function list(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
  }
  catch {
    return []
  }
}

async function importRows(tx: Db, data: Export): Promise<string> {
  const skipped: string[] = []
  const users = new Set<string>()
  const orgs = new Set<string>()
  const instances = new Set<string>()

  const ref = (set: Set<string>, id: string | undefined) => (id && set.has(id) ? id : null)

  for (const row of data.users) {
    if (!row.id || !row.email || !row.password) {
      skipped.push(`user ${row.id || '?'} (no email or password)`)
      continue
    }
    await tx`
      INSERT INTO app.users (id, email, name, password_hash, created)
      VALUES (${row.id}, ${normaliseEmail(row.email)}, ${row.name}, ${row.password}, ${date(row.created) ?? new Date().toISOString()})
    `
    users.add(row.id)
  }

  for (const row of data.organizations) {
    await tx`
      INSERT INTO app.organizations (id, name, created)
      VALUES (${row.id}, ${(row.name || 'Organization').slice(0, 100)}, ${date(row.created) ?? new Date().toISOString()})
    `
    orgs.add(row.id)
  }

  for (const row of data.memberships) {
    if (!users.has(row.user) || !orgs.has(row.org)) {
      skipped.push(`membership ${row.id}`)
      continue
    }
    await tx`
      INSERT INTO app.memberships (id, org, user_id, role, created)
      VALUES (${row.id}, ${row.org}, ${row.user}, ${row.role === 'admin' ? 'admin' : 'member'}, ${date(row.created) ?? new Date().toISOString()})
    `
  }

  for (const row of data.instances) {
    if (!orgs.has(row.org)) {
      skipped.push(`connection ${row.id} (${row.label || row.name}) — no organization`)
      continue
    }
    const port = Number(row.db_port)
    await tx`
      INSERT INTO app.instances (
        id, org, created_by, kind, name, instance_id, api_key, admin_key, base_url,
        evolution_db_url, telegram_db_url, dsn, db_host, db_port, db_database, label,
        down_since, alerted_at, created
      ) VALUES (
        ${row.id}, ${row.org}, ${ref(users, row.created_by)}, ${row.kind || 'whatsapp'}, ${row.name},
        ${row.instance_id}, ${row.api_key}, ${row.admin_key}, ${row.base_url},
        ${row.evolution_db_url}, ${row.telegram_db_url}, ${row.dsn}, ${row.db_host},
        ${Number.isInteger(port) && port > 0 ? port : null}, ${row.db_database}, ${row.label},
        ${date(row.down_since)}, ${date(row.alerted_at)}, ${date(row.created) ?? new Date().toISOString()}
      )
    `
    instances.add(row.id)
  }

  for (const row of data.instance_assignments) {
    if (!users.has(row.user) || !instances.has(row.instance)) {
      skipped.push(`assignment ${row.id}`)
      continue
    }
    await tx`
      INSERT INTO app.instance_assignments (id, instance, user_id, created)
      VALUES (${row.id}, ${row.instance}, ${row.user}, ${date(row.created) ?? new Date().toISOString()})
    `
  }

  for (const row of data.invitations) {
    if (!orgs.has(row.org)) {
      skipped.push(`invitation ${row.id}`)
      continue
    }
    await tx`
      INSERT INTO app.invitations (
        id, org, email, role, code_hash, invited_by, accepted_by, expires_at, accepted_at, revoked, created
      ) VALUES (
        ${row.id}, ${row.org}, ${normaliseEmail(row.email)}, ${row.role === 'admin' ? 'admin' : 'member'},
        ${row.code_hash}, ${ref(users, row.invited_by)}, ${ref(users, row.accepted_by)},
        ${date(row.expires_at)}, ${date(row.accepted_at)}, ${bool(row.revoked)}, ${date(row.created) ?? new Date().toISOString()}
      )
    `
  }

  let tokens = 0
  for (const row of data.mcp_tokens) {
    if (!users.has(row.assigned_to) || !instances.has(row.instance)) {
      skipped.push(`token ${row.id}`)
      continue
    }
    await tx`
      INSERT INTO app.mcp_tokens (
        id, assigned_to, created_by, instance, token_hash, label, last_used_at, expires_at, revoked,
        all_chats, chat_jids, all_tables, table_names, all_tools, tool_names, created
      ) VALUES (
        ${row.id}, ${row.assigned_to}, ${ref(users, row.created_by)}, ${row.instance}, ${row.token_hash},
        ${row.label}, ${date(row.last_used_at)}, ${date(row.expires_at)}, ${bool(row.revoked)},
        ${bool(row.all_chats)}, ${list(row.chat_jids)}, ${bool(row.all_tables)}, ${list(row.table_names)},
        ${bool(row.all_tools)}, ${list(row.tool_names)}, ${date(row.created) ?? new Date().toISOString()}
      )
    `
    tokens++
  }

  if (skipped.length) {
    console.warn(`[import] skipped ${skipped.length} row(s) that point at something missing: ${skipped.join('; ')}`)
  }

  return `${users.size} users, ${orgs.size} organizations, ${instances.size} connections, ${tokens} tokens`
}
