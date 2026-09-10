import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppUser } from './pocketbase'

/**
 * Evolution instance lifecycle. Every call that touches Evolution's instance
 * endpoints lives here, so the admin-key blast radius is one file.
 */

export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

// A type alias rather than an interface on purpose: MCP tool handlers may return
// `Record<string, unknown>`, and interfaces have no implicit index signature, so
// an interface here fails to typecheck at the tool that returns it.
export type InstanceStatus = {
  state: ConnectionState
  profileName?: string
  profilePicUrl?: string
  number?: string
  ownerJid?: string
  disconnectedAt?: string
  stats: {
    messages: number
    chats: number
    contacts: number
  }
}

export interface InstanceQr {
  base64?: string
  code?: string
  pairingCode?: string
  count?: number
}

/** What the UI is allowed to see. Never includes a secret field. */
export interface PublicInstance {
  id: string
  kind: InstanceKind
  name: string
  label: string
  created?: string
  /**
   * Where this connection points, for display. The Evolution base URL is not a
   * secret; the Postgres DSN is, so only its host, port and database name are
   * surfaced and never the credentials in it.
   */
  target?: string
  /** True when this WhatsApp connection uses a server the user supplied. */
  ownServer?: boolean
  /**
   * Whether `read-messages` and `search-messages` can answer for this
   * connection at all.
   *
   * Computed here rather than in the client: it depends on the precedence
   * between a connection's own database URL and the deployment's variable, and
   * a second implementation of that rule in the UI would drift.
   */
  canReadMessages?: boolean
}

export function toPublicInstance(instance: AppInstance): PublicInstance {
  const kind = instanceKind(instance)
  return {
    id: instance.id,
    kind,
    name: instance.name,
    label: instance.label || (kind === 'postgres' ? 'Database' : 'WhatsApp account'),
    created: instance.created,
    target: kind === 'postgres'
      ? [instance.pg_host, instance.pg_port].filter(Boolean).join(':')
        + (instance.pg_database ? `/${instance.pg_database}` : '')
      : instance.base_url,
    ...(kind === 'whatsapp' && {
      ownServer: Boolean(instance.admin_key),
      // Not recomputed here: `canReadMessages` in evolution-db.ts is the rule,
      // and the comment there calls itself the only place it lives.
      canReadMessages: canReadMessages(instance),
    }),
  }
}

/**
 * Instance names are server-generated and land in Evolution's URLs. Random
 * rather than derived from the user id, so one user can hold several and no
 * name leaks who owns it.
 */
function generateInstanceName(): string {
  return `i-${randomBytes(8).toString('base64url')}`
}

export async function listInstancesForUser(userId: string): Promise<AppInstance[]> {
  const pb = await pocketbaseAdmin()
  return await pb.collection('instances').getFullList<AppInstance>({
    filter: pb.filter('user = {:uid}', { uid: userId }),
    sort: 'created',
  })
}

/**
 * Resolve an instance id from the URL against the session user.
 *
 * Answers **404** rather than 403 when the instance belongs to someone else —
 * a 403 would confirm the id exists and turn this route into a probe.
 */
export async function requireOwnedInstance(event: H3Event, instanceId: string | undefined): Promise<AppInstance> {
  const user = await requireSessionUser(event)

  if (!instanceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const pb = await pocketbaseAdmin()

  let instance: AppInstance
  try {
    instance = await pb.collection('instances').getOne<AppInstance>(instanceId)
  } catch (error) {
    if (isPocketBaseNotFound(error)) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    throw error
  }

  if (instance.user !== user.id) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  return instance
}

/**
 * Create an Evolution instance and record it.
 *
 * Two systems, so there is a window where they can disagree. Evolution is
 * written first; if the PocketBase write then fails we issue a compensating
 * delete so no orphan instance is left holding a socket on the Evolution
 * server. That compensating call is best-effort by necessity — if it also
 * fails, the original error is still what the caller needs to see.
 *
 * This is also the single place an instances-per-user cap would go.
 */
export interface WhatsappProvisionInput {
  label?: string
  /**
   * A bring-your-own Evolution server. `baseUrl` and `adminKey` are both halves
   * of one thing and must arrive together; `dbUrl` is independently optional —
   * without it the account pairs and sends but cannot be read, because reads go
   * to Evolution's database and this app would not know which one.
   */
  server?: { baseUrl: string, adminKey: string, dbUrl?: string }
}

export async function provisionWhatsappInstance(
  user: AppUser,
  input: WhatsappProvisionInput = {},
): Promise<AppInstance> {
  const { label, server } = input

  // Guarded before the first request rather than only inside the client, so a
  // bad URL fails the create with a message about the URL instead of surfacing
  // as a failed Evolution call.
  if (server) await assertPublicUrl(server.baseUrl, 'Evolution server URL')

  // Proved before anything is provisioned, so a bad database URL costs nothing
  // — no Evolution instance to tear down, no row to clean up. `requireTable`
  // catches the case that matters: a URL that connects to the wrong database.
  if (server?.dbUrl) await probePgConnection(server.dbUrl, { requireTable: '"Message"' })

  const creds = evolutionAdminCredentials(
    server ? { base_url: server.baseUrl, admin_key: server.adminKey } : undefined,
  )
  if (!creds) {
    throw createError({
      statusCode: 422,
      statusMessage: 'No Evolution server is available. Set NUXT_EVOLUTION_URL and '
        + 'NUXT_EVOLUTION_ADMIN_KEY to provide a default, or supply your own server '
        + 'URL and admin key.',
    })
  }

  const admin = createEvolutionClient(creds)
  const name = generateInstanceName()

  const created = await admin<{ instance?: { instanceId?: string }, hash?: string | { apikey?: string } }>(
    '/instance/create',
    {
      method: 'POST',
      body: {
        instanceName: name,
        integration: 'WHATSAPP-BAILEYS',
        // Creating without a QR returns immediately; Evolution otherwise blocks
        // ~5s waiting for one. The pairing page asks for the QR separately.
        qrcode: false,
        // WhatsApp hands over history exactly once, during the initial login, so
        // this has to be true *before* the QR is scanned — there is no endpoint
        // that fetches history later. Side effect worth knowing: Evolution's
        // `shouldIgnoreJid` stops filtering `@g.us` when this is on, so group
        // chats sync too, regardless of `groupsIgnore`.
        syncFullHistory: true,
      },
    },
  )

  // Older Evolution releases returned `hash` as `{ apikey }`. We pin v2.3.7,
  // where it is a plain string, but accept both so an upgrade fails loudly at
  // the check below rather than silently storing "[object Object]".
  const apiKey = typeof created?.hash === 'string' ? created.hash : created?.hash?.apikey

  if (!apiKey) {
    await admin(`/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    throw createError({
      statusCode: 502,
      statusMessage: 'Evolution API did not return an instance token',
    })
  }

  try {
    const pb = await pocketbaseAdmin()
    return await pb.collection('instances').create<AppInstance>({
      user: user.id,
      kind: 'whatsapp',
      name,
      instance_id: created?.instance?.instanceId ?? '',
      api_key: apiKey,
      // The URL actually used, never runtimeConfig — otherwise a BYO instance
      // would be recorded as living on our server and every later call would go
      // to the wrong one.
      base_url: creds.baseUrl,
      // Stored only for a server the user supplied. A connection on the
      // deployment default keeps following that default, including if it moves.
      admin_key: server ? server.adminKey : '',
      // Same: only ever set for a user's own server. A default-server connection
      // reads through NUXT_EVOLUTION_DATABASE_URL and must not carry an override.
      evolution_db_url: server?.dbUrl ?? '',
      label: label?.trim() || 'WhatsApp account',
    })
  } catch (error) {
    await admin(`/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    throw error
  }
}

/**
 * Ownership *and* kind, for a route that only makes sense for one kind.
 *
 * 404 for the wrong kind, matching `requireOwnedInstance`'s reason for
 * answering 404 rather than 403: the route genuinely does not exist for this
 * connection, and a distinguishable error would confirm which id is which kind.
 */
export async function requireOwnedInstanceOfKind(
  event: H3Event,
  instanceId: string | undefined,
  kind: InstanceKind,
): Promise<AppInstance> {
  const instance = await requireOwnedInstance(event, instanceId)
  if (instanceKind(instance) !== kind) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return instance
}

/**
 * Health of one connection, whatever kind it is.
 *
 * `state` uses the same four values for both kinds so the listing can render a
 * badge without branching: a database that answers is `open`, one that does not
 * is `close`, and a row with no DSN at all is `unknown` — the same shape as a
 * WhatsApp account that Evolution cannot be asked about.
 *
 * A type alias, not an interface, for the reason `InstanceStatus` gives.
 */
export type ConnectionHealth = {
  state: ConnectionState
  /** Human-readable line for the card: profile name, or database and version. */
  detail?: string
  error?: string
}

export async function getPostgresHealth(instance: AppInstance): Promise<ConnectionHealth> {
  if (!instance.dsn) return { state: 'unknown', error: 'No connection string is stored for this database.' }

  try {
    const identity = await pgIdentity(await pgFor(instance))
    return {
      state: 'open',
      detail: identity ? `PostgreSQL ${identity.serverVersion} · ${identity.database}` : undefined,
    }
  }
  catch (cause) {
    // The DSN carries a password and the driver's message can echo connection
    // parameters, so only the code is surfaced. Logged here because a handled
    // error is invisible to Nitro and "it just says disconnected" is not a
    // diagnosis.
    console.error(`[pg] health check failed for instance ${instance.id}`, cause)
    const detail = (cause as { statusCode?: number, message?: string })
    return {
      state: 'close',
      error: detail?.statusCode === 422
        ? detail.message
        : `Could not reach the database (${(cause as { code?: string })?.code ?? 'connection failed'}).`,
    }
  }
}

/**
 * Record a Postgres connection.
 *
 * Nothing is provisioned: the database already exists and belongs to the user.
 * But the DSN is proved to work *before* the row is written, so a typo is a
 * failed create with a message about the connection string rather than a row
 * that looks connected and fails every later tool call. That is the same
 * ordering rule as the WhatsApp path, arrived at from the other direction —
 * there, the remote thing is made first because it is the part that can leak.
 *
 * `name` is generated for a Postgres row too. It reaches no external system
 * here, but `instances.name` is required and uniquely indexed, and leaving one
 * kind out of that would make every query that touches `name` conditional.
 */
export interface PostgresProvisionInput {
  label?: string
  dsn: string
}

export async function provisionPostgresInstance(
  user: AppUser,
  input: PostgresProvisionInput,
): Promise<AppInstance> {
  const dsn = input.dsn.trim()
  const { fields, probe } = await postgresFields(dsn)

  const pb = await pocketbaseAdmin()
  return await pb.collection('instances').create<AppInstance>({
    user: user.id,
    kind: 'postgres',
    name: generateInstanceName(),
    ...fields,
    label: input.label?.trim() || probe.database || 'Database',
  })
}

/**
 * Prove a DSN and build the columns that go with it.
 *
 * The secret and its display-only mirrors are written together, in one place,
 * so a new mirror cannot be added to the create path and forgotten on the
 * update path — a miss there is silent, leaving a row that simply lacks the
 * field.
 */
async function postgresFields(dsn: string) {
  // Parses, runs the host guard, connects, and reports the role's privileges.
  const probe = await probePgConnection(dsn)
  const target = describeDsn(dsn)

  return {
    probe,
    fields: {
      dsn,
      pg_host: target.host,
      pg_port: target.port,
      pg_database: probe.database,
    },
  }
}

/** Rotate a database connection's DSN. Every token on it keeps working. */
export async function updatePostgresDsn(instance: AppInstance, dsn: string): Promise<AppInstance> {
  const { fields } = await postgresFields(dsn)

  const pb = await pocketbaseAdmin()
  const updated = await pb.collection('instances').update<AppInstance>(instance.id, fields)

  // Drop the pool so the change takes effect now rather than at the next
  // fingerprint check. Belt and braces — `pgFor` would notice on its own.
  await closePgPool(instance.id)

  return updated
}

/**
 * Connection state and counts, in one call.
 *
 * `fetchInstances` with an instance's own token returns only that instance —
 * Evolution enforces the scoping, we do not have to filter. An unpaired or
 * unknown instance reports `close` and zeroes rather than throwing, because the
 * dashboard should render for an account that has never been paired.
 */
export async function getInstanceStatus(instance: AppInstance): Promise<InstanceStatus> {
  const evolution = evolutionClientForInstance(instance)

  let rows: EvolutionInstanceRow[] = []
  try {
    rows = await evolution<EvolutionInstanceRow[]>('/instance/fetchInstances')
  } catch {
    return emptyStatus()
  }

  const row = Array.isArray(rows) ? rows.find(r => r?.name === instance.name) ?? rows[0] : undefined
  if (!row) return emptyStatus()

  return {
    state: normalizeState(row.connectionStatus),
    profileName: row.profileName ?? undefined,
    profilePicUrl: row.profilePicUrl ?? undefined,
    number: row.number ?? row.ownerJid?.split('@')[0],
    ownerJid: row.ownerJid ?? undefined,
    disconnectedAt: row.disconnectionAt ?? undefined,
    stats: {
      messages: row._count?.Message ?? 0,
      chats: row._count?.Chat ?? 0,
      contacts: row._count?.Contact ?? 0,
    },
  }
}

/**
 * Current QR, or the connection state once pairing has completed.
 *
 * `GET /instance/connect` is overloaded upstream: it returns a QR while the
 * instance is `close`/`connecting`, and a connection-state object once it is
 * `open`. Hitting it while `close` is also what starts the connection, so the
 * pairing page polling this is what drives pairing forward.
 */
export async function getInstanceQr(instance: AppInstance): Promise<{ state: ConnectionState, qr?: InstanceQr }> {
  const evolution = evolutionClientForInstance(instance)

  const response = await evolution<Record<string, any>>(
    `/instance/connect/${encodeURIComponent(instance.name)}`,
  )

  if (response?.instance?.state) {
    return { state: normalizeState(response.instance.state) }
  }

  if (response?.base64 || response?.code || response?.pairingCode) {
    return {
      state: 'connecting',
      qr: {
        base64: response.base64,
        code: response.code,
        pairingCode: response.pairingCode,
        count: response.count,
      },
    }
  }

  // Evolution returns an empty object in the moment between starting the
  // connection and the first QR being generated. Not an error — poll again.
  return { state: 'connecting' }
}

/**
 * End the WhatsApp session, keeping the instance and its token.
 *
 * Evolution answers 400 when the instance is already disconnected. That is the
 * state the caller asked for, so it is treated as success.
 */
export async function logoutInstance(instance: AppInstance): Promise<void> {
  const evolution = evolutionClientForInstance(instance)
  try {
    await evolution(`/instance/logout/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
  } catch (error) {
    if ((error as { status?: number, statusCode?: number })?.status === 400
      || (error as { statusCode?: number })?.statusCode === 400) {
      return
    }
    throw error
  }
}

/**
 * Turn on full-history sync, then drop the WhatsApp session so the next pairing
 * imports it.
 *
 * WhatsApp hands history over exactly once, during the initial login. An account
 * paired while `syncFullHistory` was off cannot be backfilled in place — Evolution
 * exposes no endpoint that fetches history after the fact. The only way in is to
 * log out and re-scan, which is why the setting and the logout are one call: the
 * setting alone does nothing, and the logout alone costs a QR scan on a real phone
 * for no gain.
 *
 * Callers must confirm with the user first. This disconnects the account.
 */
export async function enableFullHistorySync(instance: AppInstance): Promise<void> {
  const evolution = evolutionClientForInstance(instance)
  const name = encodeURIComponent(instance.name)

  // Read-modify-write, never a partial write. Evolution's `setSettings` copies
  // every field of the body onto the live instance's in-memory settings, so a key
  // left out of the request becomes `undefined` there until the process restarts
  // — omitting `groupsIgnore` silently un-sets it on a running socket. Its schema
  // also *requires* all six booleans, so a partial body is a 400 anyway.
  // Not caught: `find` answers `null` when the instance has no settings row yet,
  // so anything thrown here is a real failure. Swallowing it would mean writing
  // defaults over settings we simply failed to read.
  const current = await evolution<EvolutionSettings | null>(`/settings/find/${name}`)

  await evolution(`/settings/set/${name}`, {
    method: 'POST',
    body: settingsBody(current, { syncFullHistory: true }),
  })

  // The new setting only reaches Baileys when the socket is next constructed, and
  // that only counts as a fresh device link — the thing that triggers a history
  // sync — if the stored credentials are gone. Logging out removes them.
  await logoutInstance(instance)
}

/**
 * Destroy the instance: the Evolution instance and everything it stored, plus
 * the PocketBase row. `mcp_tokens` rows cascade away with it, so every token
 * for this account stops authenticating.
 *
 * Evolution is torn down first — if that fails we keep the row, because a row
 * pointing at a live instance is recoverable and a live instance nobody has a
 * record of is not. Evolution logs the instance out itself if it is connected.
 *
 * A Postgres connection owns nothing outside this app: there is no remote
 * resource to release, only a local pool to close.
 */
export async function deleteInstance(instance: AppInstance): Promise<void> {
  // Release whatever this kind holds, then delete the row — once, for every
  // kind. The ordering is the rule stated above and it is the same either way:
  // if releasing throws, the row survives and still points at the thing.
  if (instanceKind(instance) === 'postgres') {
    await closePgPool(instance.id)
  }
  else {
    // A connection on its own server may hold a pool onto that server's message
    // database. Keyed on the row, so it outlives the row unless dropped here.
    await closeKeyedPool(`evo:${instance.id}`)

    // Uses the same server the instance was created on, with that server's own
    // global key when it brought one.
    const admin = evolutionAdminClient(instance)

    try {
      await admin(`/instance/delete/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
    } catch (error) {
      // A 404 means Evolution has already lost it; carry on and clean up our row.
      const status = (error as { status?: number, statusCode?: number })
      if (status?.status !== 404 && status?.statusCode !== 404) throw error
    }
  }

  const pb = await pocketbaseAdmin()
  await pb.collection('instances').delete(instance.id)
}

// ── internals ──────────────────────────────────────────────────────────────

interface EvolutionInstanceRow {
  name?: string
  connectionStatus?: string
  ownerJid?: string
  profileName?: string
  profilePicUrl?: string
  number?: string
  disconnectionAt?: string
  _count?: { Message?: number, Chat?: number, Contact?: number }
}

interface EvolutionSettings {
  rejectCall?: boolean
  msgCall?: string | null
  groupsIgnore?: boolean
  alwaysOnline?: boolean
  readMessages?: boolean
  readStatus?: boolean
  syncFullHistory?: boolean
  wavoipToken?: string | null
}

/**
 * A settings body Evolution will accept.
 *
 * Its schema marks all six booleans `required`, and types `msgCall`/`wavoipToken`
 * as `string` — so a missing boolean is a 400, and a `null` string (which is what
 * `settings/find` returns for an unset one) is also a 400. Default the booleans,
 * drop the empty strings.
 */
function settingsBody(current: EvolutionSettings | null, overrides: Partial<EvolutionSettings>): Record<string, unknown> {
  const merged = { ...current, ...overrides }

  const body: Record<string, unknown> = {
    rejectCall: merged.rejectCall ?? false,
    groupsIgnore: merged.groupsIgnore ?? false,
    alwaysOnline: merged.alwaysOnline ?? false,
    readMessages: merged.readMessages ?? false,
    readStatus: merged.readStatus ?? false,
    syncFullHistory: merged.syncFullHistory ?? false,
  }

  if (merged.msgCall) body.msgCall = merged.msgCall
  if (merged.wavoipToken) body.wavoipToken = merged.wavoipToken

  return body
}

function emptyStatus(): InstanceStatus {
  return { state: 'close', stats: { messages: 0, chats: 0, contacts: 0 } }
}

function normalizeState(state: string | undefined): ConnectionState {
  return state === 'open' || state === 'connecting' || state === 'close' ? state : 'unknown'
}
