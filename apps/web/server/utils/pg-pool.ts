import { createHash } from 'node:crypto'
import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { AppInstance } from './pocketbase'

/**
 * Connections to *user-supplied* Postgres databases.
 *
 * `evolution-db.ts` memoizes one process-global pool because there is one
 * Evolution database and this app chose its address. Everything here is
 * different: the address comes from a user, there is one pool per connection
 * row, a user can rotate a DSN at any time, and a busy server holds many at
 * once. So: keyed cache, fingerprint invalidation, and a ceiling.
 *
 * **The address is pinned, not merely checked.** `assertPublicTarget` resolves
 * the DSN's host and approves an address, and that address is what
 * `postgres({ host })` dials — postgres.js prefers the `host` option over the
 * URL's hostname. A hostname that answers publicly for our lookup and privately
 * for the driver's cannot exist, because the driver never performs one. This is
 * the half of the DNS-rebinding problem that the Evolution path (which goes
 * through `$fetch`, which resolves for itself) cannot close today.
 */

const MAX_POOLS = 32
const POOL_IDLE_MS = 10 * 60_000
const PER_POOL_MAX = 3
const CONNECT_TIMEOUT_S = 5
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000
/** How long a host stays approved before the guard is re-run on it. */
const GUARD_TTL_MS = 60_000

interface Entry {
  sql: Sql
  /** Hash of the DSN this pool was opened with. Rotating the DSN rebuilds it. */
  dsnHash: string
  /** When the host guard last approved this pool's target. */
  guardedAt: number
  lastUsed: number
}

/**
 * Keyed on the connection id, not on the DSN.
 *
 * A Map keyed on a DSN holds every user's database password as a live string in
 * a structure that shows up in a heap snapshot and in a debugger. The id is
 * enough to find the pool; a hash is enough to notice the DSN changed.
 */
const pools = new Map<string, Entry>()

export interface PgTarget {
  /** Hostname as written in the DSN. Display, and TLS servername. */
  host: string
  port: number
  database: string
  /** The address `assertPublicTarget` approved. This is what gets dialled. */
  address: string
  /** `sslmode` as the DSN asked for it, if it did. */
  sslMode?: string
}

/** Split a DSN without ever logging or returning the credentials in it. */
export function describeDsn(dsn: string): { host: string, port: number, database: string, sslMode?: string } {
  let url: URL
  try {
    url = new URL(dsn)
  }
  catch {
    throw createError({ statusCode: 422, message: 'That is not a valid Postgres connection string.' })
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw createError({
      statusCode: 422,
      message: `Connection string must start with postgres:// or postgresql://, not ${url.protocol}`,
    })
  }
  if (!url.hostname) {
    throw createError({ statusCode: 422, message: 'Connection string has no host.' })
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) {
    throw createError({ statusCode: 422, message: 'Connection string has no database name.' })
  }

  return {
    // `URL.hostname` keeps the brackets on an IPv6 literal, and `isIP('[::1]')`
    // is 0 — so without stripping them the guard tries to resolve the brackets
    // as a name and refuses every IPv6 address a user could write.
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 5432,
    database,
    sslMode: url.searchParams.get('sslmode') ?? undefined,
  }
}

/** Parse, then run the host guard. Throws 422 with something a person can act on. */
export async function resolvePgTarget(dsn: string): Promise<PgTarget> {
  const parsed = describeDsn(dsn)
  const approved = await assertPublicTarget(parsed.host, parsed.port, 'Database host')
  return { ...parsed, address: approved.address }
}

/**
 * TLS settings for a pinned address.
 *
 * Dialling an IP would otherwise blank the TLS servername (postgres.js derives
 * it from the host it connects to), so a certificate issued for the hostname
 * would fail to verify — or, worse, verification would be skipped. Carry the
 * original hostname through as `servername` so pinning does not weaken TLS.
 */
function sslFor(target: PgTarget): postgres.Options<Record<string, never>>['ssl'] {
  const mode = target.sslMode
  if (!mode || mode === 'disable') return undefined
  if (mode === 'verify-full' || mode === 'verify-ca') {
    return { servername: target.host, rejectUnauthorized: true }
  }
  // `require` and `prefer` encrypt without asserting the certificate chain,
  // which is what libpq does for those modes. Named here rather than implied.
  return { servername: target.host, rejectUnauthorized: false }
}

/**
 * Driver options shared by the pool and the throwaway probe.
 *
 * The probe is the connection that *decides whether a DSN is accepted*, so it
 * has to behave exactly like the pool that will then use it. Keeping a second
 * hand-written copy of these options meant a change to the pin, to `onnotice`
 * or to `prepare` could silently apply to one and not the other.
 */
function driverOptions(target: PgTarget, options: { guard: boolean, max: number, statementTimeoutMs: number }) {
  const ssl = sslFor(target)

  return {
    // The pin. postgres.js prefers this over the URL's hostname.
    //
    // Skipped for an IPv6 address, and that is not optional: postgres.js parses
    // its `host` option with `host.split(':')[0]` and takes the port from
    // `split(':')[1]`, so pinning `2606:4700::6810:85e5` dials host "2606" on
    // port 4700 and every IPv6-only provider (Supabase direct connections among
    // them) fails to connect at all. The guard still ran and still refused a
    // private address; only the pin is given up, so this host keeps the
    // check-don't-pin posture the Evolution path documents.
    ...(options.guard && canPin(target) && { host: target.address, port: target.port }),
    // Only when there is one: an explicit `ssl: undefined` still counts as
    // present to postgres.js's `k in o ? o[k] : query[k]`, which would override
    // a DSN's own `?ssl=true` or `?sslrootcert=…` and silently connect in the
    // clear.
    ...(options.guard && ssl !== undefined && { ssl }),
    max: options.max,
    // 5s, not the 30s default. A bad DSN has to fail the MCP call quickly; a
    // tool that hangs for half a minute reads to a client as a hung server.
    connect_timeout: CONNECT_TIMEOUT_S,
    // Pointing at a transaction-mode pooler (Supabase, Neon, pgbouncer) is the
    // common case, and a named prepared statement does not survive one.
    prepare: false,
    // A NOTICE payload can carry row data — a RAISE NOTICE in a trigger — and
    // would land in the process log, which is the one place this must not leak
    // to. `mcp.logging` is off for the same reason.
    onnotice: () => {},
    connection: {
      application_name: 'claude-mcp-connector',
      statement_timeout: options.statementTimeoutMs,
    },
  }
}

/** postgres.js cannot express an IPv6 host in its `host` option. See `driverOptions`. */
function canPin(target: PgTarget): boolean {
  return target.address !== '' && !target.address.includes(':')
}

function hashDsn(dsn: string): string {
  return createHash('sha256').update(dsn).digest('hex')
}

export interface KeyedPoolOptions {
  /**
   * Run the host guard and dial the address it approved.
   *
   * **True for anything a user typed, false only for a value that came from
   * runtimeConfig — and the asymmetry is deliberate.** This deployment's own
   * `NUXT_EVOLUTION_DATABASE_URL` legitimately sits on a private compose
   * network, and `net-guard.ts` lists it as our own infrastructure, so guarding
   * it would correctly refuse it. Guarding a user-supplied URL is what stops one
   * pointing at that same database.
   */
  guard: boolean
  max?: number
  statementTimeoutMs?: number
}

/**
 * The pool for one `key`, building it if needed.
 *
 * `key` namespaces the caller (`pg:<id>`, `evo:<id>`, `evo:default`) so two
 * purposes cannot collide on one instance id, and so a caller can evict its own
 * pool without knowing about anyone else's.
 *
 * Eviction runs here rather than on a timer: an interval outlives nothing
 * useful in a worker the platform stops and starts, and sweeping on the path
 * that already runs is deterministic and needs no lifecycle hook.
 */
export async function keyedPool(key: string, dsn: string, options: KeyedPoolOptions): Promise<Sql> {
  sweep()

  const dsnHash = hashDsn(dsn)
  const existing = pools.get(key)

  if (existing && existing.dsnHash === dsnHash) {
    // Re-approve the host on a timer, not on every call.
    //
    // **Not a shortcut — resolving per call would buy nothing.** The pool keeps
    // established sockets for up to `max_lifetime`, all of them dialled at the
    // address approved when it was built, so a fresh lookup does not move any
    // traffic. What re-approving does buy is noticing that a hostname has since
    // been re-pointed somewhere it may not go, and a minute is soon enough for
    // that; `assertPublicTarget` throws here if so.
    //
    // The address is also deliberately NOT part of the identity. A host with
    // several A records (Neon, Supabase, any round-robin) returns them in a
    // different order per query — `verbatim: true` preserves that — so keying on
    // `resolved[0]` tore down and rebuilt the pool, TLS handshake and all, on
    // essentially every call to exactly the hosts people point at.
    if (options.guard && Date.now() - existing.guardedAt > GUARD_TTL_MS) {
      await resolvePgTarget(dsn)
      existing.guardedAt = Date.now()
    }
    existing.lastUsed = Date.now()
    return existing.sql
  }

  // Unguarded means unpinned: with no approved address there is nothing to
  // substitute for the hostname, so postgres.js resolves it as usual.
  const target = options.guard
    ? await resolvePgTarget(dsn)
    : { ...describeDsn(dsn), address: '' }

  if (existing) {
    // The DSN was rotated. Drain the old pool in the background: ending it
    // synchronously would kill queries still in flight on this request and on
    // any concurrent one.
    pools.delete(key)
    void existing.sql.end({ timeout: 5 }).catch(() => {})
  }

  const sql = postgres(dsn, {
    ...driverOptions(target, {
      guard: options.guard,
      max: options.max ?? PER_POOL_MAX,
      statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    }),
    idle_timeout: 30,
    max_lifetime: 60 * 30,
  })

  pools.set(key, { sql, dsnHash, guardedAt: Date.now(), lastUsed: Date.now() })
  return sql
}

/** Drop one pool by key. */
export async function closeKeyedPool(key: string): Promise<void> {
  const entry = pools.get(key)
  if (!entry) return
  pools.delete(key)
  await entry.sql.end({ timeout: 5 }).catch(() => {})
}

/** The pool for a Postgres *connection* — the kind a user configured as one. */
export async function pgFor(instance: Pick<AppInstance, 'id' | 'dsn'>): Promise<Sql> {
  const dsn = instance.dsn
  if (!dsn) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This database connection has no connection string.',
    })
  }
  return keyedPool(`pg:${instance.id}`, dsn, { guard: true })
}

export function closePgPool(instanceId: string): Promise<void> {
  return closeKeyedPool(`pg:${instanceId}`)
}

function sweep(): void {
  const now = Date.now()

  for (const [id, entry] of pools) {
    if (now - entry.lastUsed > POOL_IDLE_MS) {
      pools.delete(id)
      void entry.sql.end({ timeout: 5 }).catch(() => {})
    }
  }

  while (pools.size > MAX_POOLS) {
    let oldest: [string, Entry] | undefined
    for (const entry of pools) {
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry
    }
    if (!oldest) break
    pools.delete(oldest[0])
    void oldest[1].sql.end({ timeout: 5 }).catch(() => {})
  }
}

/**
 * Open a throwaway connection to prove a DSN works, and report what is behind
 * it. Used when a connection is created, so a broken DSN fails the create
 * rather than becoming a row that fails every later tool call.
 *
 * The privilege report is not decoration. A superuser DSN makes the per-token
 * table allowlist best-effort — a superuser can read anything through a
 * function the planner cannot see into — so the UI has to be able to say so.
 */
/** What a connection says about itself. One query, three callers. */
export interface PgIdentity {
  serverVersion: string
  currentUser: string
  database: string
}

export async function pgIdentity(sql: Sql): Promise<PgIdentity | undefined> {
  const [row] = await sql<Array<{ version: string, current_user: string, database: string }>>`
    SELECT current_setting('server_version') AS version,
           current_user,
           current_database() AS database`
  if (!row) return undefined
  return { serverVersion: row.version, currentUser: row.current_user, database: row.database }
}

export interface PgProbe {
  serverVersion: string
  currentUser: string
  database: string
  superuser: boolean
  bypassRls: boolean
  canReadServerFiles: boolean
}

export async function probePgConnection(dsn: string, options: {
  /**
   * A table that must exist and be readable, as `pg_catalog.has_table_privilege`
   * spells it — e.g. `"Message"` for an Evolution database.
   *
   * Connecting is not the same as pointing at the right database. A URL with the
   * right host, user and password but the wrong database name connects happily
   * and then matches no rows, which reads as an account with no messages: the
   * exact silent-empty failure the caller is trying to remove. Naming the table
   * turns that into a refusal at save time.
   */
  requireTable?: string
} = {}): Promise<PgProbe> {
  const target = await resolvePgTarget(dsn)

  // Same options as the pool that will use this DSN, so acceptance and use
  // cannot disagree.
  const sql = postgres(dsn, driverOptions(target, { guard: true, max: 1, statementTimeoutMs: 5000 }))

  try {
    const [row] = await sql<Array<{
      version: string
      current_user: string
      database: string
      superuser: boolean
      bypass_rls: boolean
      can_read_files: boolean
    }>>`
      -- A superset of pgIdentity's columns: the privilege half is only ever
      -- needed here, at the moment a DSN is accepted.
      SELECT current_setting('server_version') AS version,
             current_user,
             current_database() AS database,
             r.rolsuper       AS superuser,
             r.rolbypassrls   AS bypass_rls,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_roles m
               WHERE m.rolname = 'pg_read_server_files'
                 AND pg_catalog.pg_has_role(current_user, m.oid, 'MEMBER')
             ) AS can_read_files
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user`

    if (!row) {
      throw createError({ statusCode: 502, message: 'The database did not identify itself.' })
    }

    if (options.requireTable) {
      const [check] = await sql<Array<{ readable: boolean | null }>>`
        SELECT pg_catalog.has_table_privilege(${options.requireTable}, 'SELECT') AS readable`
        // A missing relation raises 42P01 rather than answering false.
        .catch(() => [{ readable: null }])

      if (!check?.readable) {
        throw createError({
          statusCode: 422,
          message: `Connected to ${target.host}:${target.port}/${row.database}, but its `
            + `${options.requireTable} table is not there or not readable by ${row.current_user}. `
            + 'Check that this is the right database and that the role has SELECT on it.',
        })
      }
    }

    return {
      serverVersion: row.version,
      currentUser: row.current_user,
      database: row.database,
      superuser: row.superuser,
      bypassRls: row.bypass_rls,
      canReadServerFiles: row.can_read_files,
    }
  }
  catch (cause) {
    if ((cause as { statusCode?: number })?.statusCode) throw cause
    // The DSN carries a password; never let the driver's message, which may
    // echo connection parameters, reach the client verbatim.
    console.error(`[pg] probe failed for ${target.host}:${target.port}/${target.database}`, cause)
    throw createError({
      statusCode: 422,
      message: `Could not connect to ${target.host}:${target.port}/${target.database}. `
        + `Check the host, port, database, user and password, and that this server is allowed to reach it. `
        + `(${(cause as { code?: string })?.code ?? 'connection failed'})`,
    })
  }
  finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}
