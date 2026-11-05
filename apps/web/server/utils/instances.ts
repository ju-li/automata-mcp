import { assertNever } from '#shared/connection'
import { randomBytes } from 'node:crypto'
import type { AppInstance } from './app-db'
import type { EvolutionInstanceRecord } from './evolution-db'
import type { ImapSecurity, ImapTarget } from './imap-client'
import type { HostedEvent } from './hosted-events'
import type { Actor } from './org'
import type { ConnectionState } from '#shared/connection'

/**
 * Evolution instance lifecycle. Every call that touches Evolution's instance
 * endpoints lives here, so the admin-key blast radius is one file.
 */

// Declared in `shared/connection.ts`; see there for why it is not local.
export type { ConnectionState }

// A type alias rather than an interface on purpose: MCP tool handlers may return
// `Record<string, unknown>`, and interfaces have no implicit index signature, so
// an interface here fails to typecheck at the tool that returns it.
export type InstanceStatus = {
  /** Evolution's live, in-memory state — not its stored column. See `getInstanceStatus`. */
  state: ConnectionState
  /**
   * The account was connected and its socket no longer is, with the phone still
   * linked. Distinct from never having paired, and answered by reconnecting
   * rather than by scanning a QR code.
   */
  sessionLost?: boolean
  /**
   * Evolution has been reopening this account's socket over and over for at
   * least `CHURN_CONFIRM_MS`, while its column reads `open`. Reconnect cannot
   * end it; restarting the Evolution service does. See `rowChurn`.
   */
  flapping?: boolean
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
  /**
   * WhatsApp only, and only while it has never been paired: when
   * `reapUnpairedConnections` will delete it. Absent once paired, for good.
   */
  unpairedRemovalAt?: string
}

export function toPublicInstance(instance: AppInstance): PublicInstance {
  const kind = instanceKind(instance)
  const base = { id: instance.id, kind, name: instance.name, created: instance.created }

  switch (kind) {
    case 'postgres':
      return {
        ...base,
        label: instance.label || 'Database',
        target: [instance.db_host, instance.db_port].filter(Boolean).join(':')
          + (instance.db_database ? `/${instance.db_database}` : ''),
      }
    case 'whatsapp':
      return {
        ...base,
        label: instance.label || 'WhatsApp account',
        target: instance.base_url,
        ownServer: Boolean(instance.admin_key),
        // Not recomputed here: `canReadMessages` in evolution-db.ts is the rule,
        // and the comment there calls itself the only place it lives.
        canReadMessages: canReadMessages(instance),
        unpairedRemovalAt: unpairedRemovalAt(instance),
      }
    case 'telegram':
      return {
        ...base,
        label: instance.label || 'Telegram account',
        target: instance.base_url,
        // A bridge the user runs carries its own admin key.
        ownServer: Boolean(instance.admin_key),
        // Telegram's own rule, not Evolution's: see `telegramDbUrlFor`.
        canReadMessages: canReadTelegramMessages(instance),
      }
    case 'imap':
      return {
        ...base,
        label: instance.label || 'Mailbox',
        // The login and the server, never the password.
        target: instance.imap_user && instance.imap_host
          ? `${instance.imap_user} @ ${instance.imap_host}:${instance.imap_port ?? ''}`
          : undefined,
      }
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * Instance names are server-generated and land in Evolution's URLs. Random
 * rather than derived from the user id, so one user can hold several and no
 * name leaks who owns it.
 */
export function generateInstanceName(): string {
  return `i-${randomBytes(8).toString('base64url')}`
}

/**
 * The connections one actor may see.
 *
 * An admin sees their whole organization's; a member sees only what is assigned
 * to them. Both are a **predicate in the query**, never a filter applied to rows
 * after they are read — the same rule chat scope and the Postgres table
 * allowlist follow, and it is what keeps this from becoming an enumeration
 * surface: a member must not learn the size or the labels of the estate.
 */
export async function listInstancesForActor(actor: Actor): Promise<AppInstance[]> {
  const sql = await appDb()

  if (actor.role === 'admin') {
    return await sql<AppInstance[]>`
      SELECT * FROM app.instances WHERE org = ${actor.org.id} ORDER BY created
    `
  }

  // The organization predicate is kept even though every assignment already
  // implies it: an assignment left behind by a member who has since moved
  // organizations must not reach back into their old one.
  return await sql<AppInstance[]>`
    SELECT i.* FROM app.instances i
    JOIN app.instance_assignments a ON a.instance = i.id AND a.user_id = ${actor.user.id}
    WHERE i.org = ${actor.org.id}
    ORDER BY i.created
  `
}

/**
 * Create an Evolution instance and record it.
 *
 * Two systems, so there is a window where they can disagree. Evolution is
 * written first; if the database write then fails we issue a compensating
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
  actor: Actor,
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

  let record: AppInstance

  try {
    record = await insertRow<AppInstance>('instances', {
      // The organization owns it; `created_by` is provenance and grants nothing.
      org: actor.org.id,
      created_by: actor.user.id,
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

  // Deliberately non-fatal, and deliberately outside the compensating-delete
  // block rather than inside it. A connection that exists in both systems is a
  // working connection; tearing down a real Evolution instance over a missing
  // alert subscription would be the wrong trade. The hourly sweep re-asserts it.
  await registerConnectionWebhook(record).catch((error) => {
    console.error(`[instances] could not register the webhook for ${record.id} (${record.name}):`, error)
  })

  return record
}

let webhookUrlWarned = false

/**
 * Subscribe this connection's Evolution instance to `CONNECTION_UPDATE`.
 *
 * Per-instance rather than global, for two separate reasons:
 *
 * - The **global** webhook sends no custom headers at all, so
 *   `NUXT_WEBHOOK_SECRET` could never be satisfied by it — setting the secret
 *   made every delivery 401, and Evolution drops a 401 rather than retrying. A
 *   per-instance webhook does send `headers`, which is what makes the secret
 *   usable at all.
 * - A connection on a **bring-your-own** Evolution server has no
 *   `WEBHOOK_GLOBAL_URL` pointing at this deployment, and no reason to: it is
 *   the user's own server. Without this call those connections would deliver
 *   nothing, and their owners would be the only ones not told when they broke.
 *
 * Uses the instance's own token. Evolution's guard accepts it for this route, so
 * the no-global-key rule in `credentialsForInstance()` is not in play.
 *
 * Idempotent — upstream `set` upserts on the instance — so the sweep can call it
 * every hour to heal a registration that was never made, or that was lost with
 * the server it lived on.
 */
export async function registerConnectionWebhook(instance: AppInstance): Promise<void> {
  const { webhookUrl, webhookSecret } = useRuntimeConfig()

  if (!webhookUrl) {
    if (!webhookUrlWarned) {
      webhookUrlWarned = true
      console.warn(
        '[instances] NUXT_WEBHOOK_URL is not set, so connections are not subscribed to '
        + 'Evolution connection events. Disconnect alerts still work, but only as fast '
        + 'as the five-minute sweep.',
      )
    }
    return
  }

  // Absent for a Postgres connection, and for a WhatsApp row that never finished
  // provisioning. Neither has anything to subscribe.
  const creds = credentialsForInstance(instance)
  if (!creds) return

  const evolution = createEvolutionClient(creds)

  await evolution(`/webhook/set/${encodeURIComponent(instance.name)}`, {
    method: 'POST',
    body: {
      webhook: {
        enabled: true,
        url: webhookUrl,
        // Sent verbatim on every per-instance delivery. Empty when no secret is
        // configured, which leaves the route unauthenticated — see
        // server/api/webhook/evolution.post.ts for why that is survivable.
        headers: webhookSecret ? { 'x-webhook-secret': webhookSecret } : {},
        // One URL for every event, not one path per event.
        byEvents: false,
        base64: false,
        // Only this one. `MESSAGES_UPSERT` would deliver every message this
        // account receives to an endpoint that has no use for them.
        events: ['CONNECTION_UPDATE'],
      },
    },
  })
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
  /** Connected, but something the user should know: a role too privileged to scope. */
  warning?: string
}

export async function getPostgresHealth(instance: AppInstance): Promise<ConnectionHealth> {
  if (!instance.dsn) return { state: 'unknown', error: 'No connection string is stored for this database.' }

  try {
    const identity = await sqlIdentity(instance)
    return {
      state: 'open',
      // `identity.server` already names the engine, so this line reads
      // correctly for whichever one answered.
      detail: identity ? `${identity.server} · ${identity.database}` : undefined,
      warning: identity?.privilegeWarning,
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
  actor: Actor,
  input: PostgresProvisionInput,
): Promise<AppInstance> {
  const dsn = input.dsn.trim()
  const { fields, probe } = await postgresFields(dsn)

  return await insertRow<AppInstance>('instances', {
    org: actor.org.id,
    created_by: actor.user.id,
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
      db_host: target.host,
      db_port: target.port,
      db_database: probe.database,
    },
  }
}

/** Rotate a database connection's DSN. Every token on it keeps working. */
export async function updatePostgresDsn(instance: AppInstance, dsn: string): Promise<AppInstance> {
  const { fields } = await postgresFields(dsn)

  const updated = await updateRow<AppInstance>('instances', instance.id, fields)

  // Drop the pool so the change takes effect now rather than at the next
  // fingerprint check. Belt and braces — `pgFor` would notice on its own.
  await closeSqlPool(instance)

  return updated
}

/**
 * Record an IMAP mailbox. Like Postgres, nothing is provisioned — but the
 * credentials are proved by logging in *before* the row is written, so a wrong
 * app password is a failed create rather than a connection that syncs nothing.
 * The first sync starts at once rather than at the next two-minute tick.
 */
export interface ImapCredentialsInput {
  host: string
  port: number
  security: ImapSecurity
  user: string
  password: string
}

export async function provisionImapInstance(
  actor: Actor,
  input: ImapCredentialsInput & { label?: string },
): Promise<AppInstance> {
  const fields = await imapFields(input)

  const instance = await insertRow<AppInstance>('instances', {
    org: actor.org.id,
    created_by: actor.user.id,
    kind: 'imap',
    name: generateInstanceName(),
    ...fields,
    label: input.label?.trim() || fields.imap_user,
  })
  await requestImapSync(instance).catch(cause => console.error(`[imap] first sync of ${instance.id} did not start`, cause))
  return instance
}

/**
 * Replace a mailbox's credentials. Tokens keep working, as for a DSN. When the
 * new login names a different mailbox, everything synced from the old one is
 * deleted first — headers from one person's inbox must not appear under
 * another's.
 */
export async function updateImapCredentials(instance: AppInstance, input: ImapCredentialsInput): Promise<AppInstance> {
  const fields = await imapFields(input)

  const updated = await updateRow<AppInstance>('instances', instance.id, fields)
  await resetIfIdentityChanged(updated, { host: fields.imap_host, user: fields.imap_user })
  // New credentials end any stop an old, refused password put on the sync.
  const sql = await appDb()
  await sql`UPDATE app.mail_sync_state SET auth_failed = false WHERE instance_id = ${instance.id}`
  await closeImapFor(instance)
  await requestImapSync(updated).catch(cause => console.error(`[imap] sync of ${instance.id} did not start`, cause))
  return updated
}

/** Prove the credentials and build the columns that hold them, for create and update alike. */
async function imapFields(input: ImapCredentialsInput) {
  const target: ImapTarget = {
    host: input.host.trim(),
    port: input.port,
    security: input.security,
    user: input.user.trim(),
    password: input.password,
  }
  await probeImapConnection(target)
  return {
    imap_host: target.host,
    imap_port: target.port,
    imap_security: target.security,
    imap_user: target.user,
    imap_password: target.password,
  }
}

/**
 * A mailbox's state, from what the sync last saw rather than a fresh login.
 *
 * The dashboard polls this, and a login every thirty seconds per open tab is
 * exactly the traffic that gets an account rate-limited. The sync logs in every
 * two minutes regardless, so its outcome *is* a recent live observation; how
 * recent is reported, and a sync that has gone quiet reads as `unknown`, not
 * as healthy.
 */
export async function getImapHealth(instance: AppInstance): Promise<ConnectionHealth> {
  if (!imapTargetOf(instance)) return { state: 'unknown', error: 'No mailbox credentials are stored for this connection.' }

  const state = await mailSyncState(instance)
  if (!state?.lastAttemptAt) return { state: 'connecting', detail: 'Waiting for the first sync.' }
  if (state.authFailed) return { state: 'close', error: imapErrorMessage('auth') }

  const failedLast = state.lastErrorAt && (!state.lastSuccessAt || state.lastErrorAt > state.lastSuccessAt)
  if (failedLast) return { state: 'close', error: imapErrorMessage(state.lastErrorCode ?? 'connection failed') }

  if (!state.lastSuccessAt) return { state: 'connecting', detail: 'The first sync is running.' }
  const age = Date.now() - Date.parse(state.lastSuccessAt)
  if (age > 15 * 60_000) {
    return { state: 'unknown', detail: `Last synced ${Math.round(age / 60_000)} minutes ago.` }
  }
  return { state: 'open', detail: `Synced ${Math.max(0, Math.round(age / 60_000))} min ago` }
}

/**
 * Connection state, profile and counts — what the dashboard, the listing and
 * `get-connection-status` show. The alert paths, which need no counts, use
 * `getInstanceHealth` instead.
 *
 * An unpaired or unknown instance reports `close` and zeroes rather than
 * throwing, because the dashboard should render for an account that has never
 * been paired.
 *
 * **The state does not come from Evolution's row.** Its `connectionStatus` is
 * Evolution's database column, and 2.3.7 writes that column only when a socket
 * opens and when one closes for a reason it will not retry (logged out,
 * forbidden, 402, 406). Every other close — a lost network, a server-side
 * termination — takes the retry path, which updates only the in-memory state.
 * When that retry never lands, the column says `open` indefinitely over a dead
 * socket, and a badge read from it says Connected for an account that has
 * received nothing for days. That was a reported bug. `GET
 * /instance/connectionState` reads the in-memory state, so it is asked
 * alongside; the row still supplies the profile.
 *
 * If that second read fails the state is `unknown`, never the column's value —
 * falling back to the column is the bug.
 *
 * `sessionLost` is the disagreement between the two, and it is what tells a
 * dropped session from an account with no session at all. A fresh instance and
 * a logout both leave the column `close`, and a QR on screen leaves it
 * `connecting`; only a retried close leaves it `open` with nothing live behind it.
 *
 * **Where the row and the counts come from — and why not `fetchInstances`.**
 * That route answers with Prisma's `_count`, which counts every account's rows
 * and joins the result to this one: a full scan of `"Message"` per call, 42% of
 * production's block reads before this changed. So, when this connection has a
 * message database (`canReadMessages`):
 *
 *   - the row is a primary-key lookup on `"Instance"` (`readInstanceRecord`),
 *     uncached, so `sessionLost` is as fresh as the poll asking;
 *   - the counts are per account (`countInstanceRows`) and cached for
 *     `COUNTS_TTL_MS` — still ~100 ms on a large account, too much for a 15 s
 *     poll. `freshCounts` bypasses that (down to a 2 s floor) for the one screen
 *     that watches counts move: the history import after pairing.
 *
 * Without a message database — a bring-your-own server with no database URL —
 * or when that SQL fails, `fetchInstances` is still asked, but cached per
 * connection (`cachedApiRow`). That is the only path on which the row can be
 * stale; see there.
 */
export async function getInstanceStatus(
  instance: AppInstance,
  options: { freshCounts?: boolean } = {},
): Promise<InstanceStatus> {
  const { rowChurn: _churn, ...status } = await readStatus(instance, { counts: true, freshCounts: options.freshCounts })
  return { ...status, stats: status.stats ?? { messages: 0, chats: 0, contacts: 0 } }
}

export type InstanceHealth = Omit<InstanceStatus, 'stats'> & {
  /**
   * The churn observation after this read, for `evaluateConnectionHealth` to
   * store — the only writer of `row_churn_since` / `row_churn_seen_at`. Not on
   * `InstanceStatus`: the dashboard and MCP get the verdict, `flapping`.
   */
  rowChurn: RowChurn
}

/**
 * `getInstanceStatus` without the counts: state, `sessionLost`, `flapping`,
 * `ownerJid`, profile. For the alert sweep and webhook evaluation, which run
 * once per connection every few minutes and read none of the counts — so they
 * never cause one to be computed.
 */
export async function getInstanceHealth(instance: AppInstance): Promise<InstanceHealth> {
  const { stats: _stats, ...health } = await readStatus(instance, { counts: false })
  return health
}

// ── pairing, recorded ──────────────────────────────────────────────────────
/**
 * How long a WhatsApp connection may exist without ever being paired before
 * `reapUnpairedConnections` deletes it. It is not inert while it waits:
 * Evolution keeps it `connecting` and generates a fresh QR every few minutes
 * (each printed to Evolution's log), holds a socket for it, and auto-connects
 * it again at every Evolution boot; it also counts against `max_connections`.
 */
export const UNPAIRED_TTL_MS = 60 * 60_000

/** When a never-paired WhatsApp connection is due for removal; `undefined` once paired. */
export function unpairedRemovalAt(instance: AppInstance): string | undefined {
  if (instanceKind(instance) !== 'whatsapp' || instance.paired_at || !instance.created) return undefined
  const created = Date.parse(instance.created)
  return Number.isNaN(created) ? undefined : new Date(created + UNPAIRED_TTL_MS).toISOString()
}

/**
 * Record, once, that this WhatsApp account has been linked — `paired_at`.
 *
 * **Ours, because Evolution's own record cannot say it.** A connection nobody
 * has scanned yet and one that was logged out both leave Evolution's column
 * `close` with no `ownerJid`; only a fact written here while the account was
 * linked tells them apart, and the reaper deletes on exactly that difference.
 *
 * Called from every live read that can see a link — `readStatus` (dashboard,
 * MCP status, alert sweep, webhook) and the pairing page's QR poll. Fire and
 * forget: the conditional UPDATE makes repeats harmless, and a failed write is
 * retried by the next read, long before the hour runs out. The in-memory set
 * only saves the write on a process that already made it.
 */
export function notePaired(instance: AppInstance): void {
  if (instance.paired_at || pairedNoted.has(instance.id)) return
  pairedNoted.add(instance.id)
  appDb()
    .then(sql => sql`UPDATE app.instances SET paired_at = now() WHERE id = ${instance.id} AND paired_at IS NULL`)
    .catch((error) => {
      pairedNoted.delete(instance.id)
      console.error(`[instances] could not record that connection ${instance.id} is paired:`, error)
    })
}

const pairedNoted = new Set<string>()

/** Like `notePaired`, but awaited — for the reaper, which acts on the answer. */
async function storePaired(instance: AppInstance): Promise<void> {
  const sql = await appDb()
  await sql`UPDATE app.instances SET paired_at = now() WHERE id = ${instance.id} AND paired_at IS NULL`
  pairedNoted.add(instance.id)
}

/**
 * Has this WhatsApp connection ever been paired — asked live, right before the
 * reaper deletes it. Records `paired_at` when the answer is yes.
 *
 *   paired    Evolution's live state is `open`, its row carries an `ownerJid`,
 *             or its database holds messages for the account. The last one is
 *             what protects a connection paired before `paired_at` existed and
 *             logged out since: no `ownerJid`, but its history is still there.
 *   unpaired  Evolution answered, and none of the above. Includes Evolution
 *             no longer knowing the instance at all (404).
 *   unknown   Something could not be asked. Never deleted on.
 *
 * Every read here is uncached. The status caches exist to spare dashboards;
 * this runs once per candidate per ten minutes and decides a deletion.
 */
export async function pairingEvidence(instance: AppInstance): Promise<'paired' | 'unpaired' | 'unknown'> {
  if (instance.paired_at) return 'paired'

  let evolution: EvolutionClient
  try {
    evolution = evolutionClientForInstance(instance)
  }
  catch {
    // No instance token: provisioning stores one before the row exists, so this
    // is a row that was edited by hand. Not ours to guess about.
    return 'unknown'
  }

  let missing = false
  try {
    if (await liveConnectionState(evolution, instance) === 'open') {
      await storePaired(instance)
      return 'paired'
    }
  }
  catch (error) {
    if (httpStatusOf(error) !== 404) return 'unknown'
    missing = true
  }

  // The row's ownerJid: from SQL where there is a message database, else from
  // Evolution's API. A 404 from either agrees with the live read that the
  // instance is gone; anything else is a read that failed.
  let ownerJid: string | undefined
  let rowRead = false
  if (canReadMessages(instance) && (instance.instance_id || !missing)) {
    try {
      const record = await readInstanceRecord(instance)
      if (record) {
        ownerJid = record.ownerJid
        rowRead = true
      }
    }
    catch {
      // Falls through to the API.
    }
  }
  if (!rowRead && !missing) {
    try {
      const rows = await evolution<EvolutionInstanceRow[]>('/instance/fetchInstances')
      const row = Array.isArray(rows) ? rows.find(r => r?.name === instance.name) : undefined
      if (!row) return 'unknown'
      ownerJid = row.ownerJid ?? undefined
    }
    catch (error) {
      if (httpStatusOf(error) !== 404) return 'unknown'
    }
  }
  if (ownerJid) {
    await storePaired(instance)
    return 'paired'
  }

  // Stored history outlives a logout. Without a message database there is
  // nothing to count, and `paired_at` plus the reads above have to do.
  if (canReadMessages(instance) && (instance.instance_id || !missing)) {
    try {
      const { messages } = await countInstanceRows(instance)
      if (messages > 0) {
        await storePaired(instance)
        return 'paired'
      }
    }
    catch {
      return 'unknown'
    }
  }

  return 'unpaired'
}

// ── reconnect loops ────────────────────────────────────────────────────────
/**
 * How recently Evolution must have written an `open` row for the read to count
 * as "a socket just opened". A loop writes it about once a second; one ordinary
 * reconnect writes it once, and stops counting this long afterwards.
 */
const ROW_RECENT_MS = 2 * 60_000
/**
 * How long recent writes must keep being seen before the connection is called
 * `flapping`. Two sweeps five minutes apart can each land just after an
 * ordinary reconnect; three in a row that all do is a socket that will not
 * settle. Also the gap in observation after which an episode starts over.
 */
const CHURN_CONFIRM_MS = 10 * 60_000

/** First and latest evaluation that saw a recent `open` write. Both absent: none seen. */
export interface RowChurn {
  since?: string
  seenAt?: string
}

/**
 * Fold one status read into the stored churn observation, and say whether it
 * now amounts to a reconnect loop.
 *
 * **Why this exists.** Evolution 2.3.7 retries every close except `loggedOut`,
 * `forbidden`, 402 and 406 — at once, with no backoff and no attempt count —
 * and `createClient` replaces `this.client` without ending the previous socket,
 * whose handlers still reconnect when it closes. Two sockets on one set of
 * credentials then replace each other (`conflict: replaced`, 440) dozens of
 * times a minute, indefinitely. The column reads `open` throughout and every
 * live read lands on whichever socket just opened, so `state` and `sessionLost`
 * both say healthy. Production ran like that for hours and nobody was told
 * (ju-li/automata-mcp#103). Only restarting the Evolution service ends it.
 *
 * **The signal is Evolution's own row, never the webhook.** Each open writes
 * the `"Instance"` row, so `updatedAt` on an `open` row trails the newest open
 * — see `EvolutionInstanceRecord.rowWrittenAt`. A count of `connection.update`
 * deliveries would say the same thing, but deliveries are unsigned and anyone
 * can post one; a stranger must not be able to mail a user that their account
 * is unstable. The webhook still matters: it makes evaluations happen, which is
 * what refreshes the observation between sweeps.
 *
 * The rule, on time rather than on sample count so the webhook's extra
 * evaluations cannot shorten it: a recent write starts an episode, every later
 * one extends it, any read that sees no recent write ends it. `flapping` once
 * an episode has been extended for `CHURN_CONFIRM_MS` and was last extended
 * within that long. A read that cannot see the write time at all — no message
 * database, a missing grant, the SQL failing — leaves the observation as it
 * was, and the last clause lets a stale one lapse on its own.
 */
export function rowChurn(
  stored: RowChurn,
  read: { columnOpen: boolean, rowWrittenAt?: string },
  now = Date.now(),
): { churn: RowChurn, flapping: boolean } {
  const churn = nextChurn(stored, read, now)
  const since = churn.since ? Date.parse(churn.since) : Number.NaN
  const seenAt = churn.seenAt ? Date.parse(churn.seenAt) : Number.NaN
  const flapping = seenAt - since >= CHURN_CONFIRM_MS && now - seenAt < CHURN_CONFIRM_MS
  return { churn, flapping }
}

function nextChurn(stored: RowChurn, read: { columnOpen: boolean, rowWrittenAt?: string }, now: number): RowChurn {
  const writtenAt = read.rowWrittenAt ? Date.parse(read.rowWrittenAt) : Number.NaN
  if (Number.isNaN(writtenAt)) return stored

  if (!read.columnOpen || now - writtenAt >= ROW_RECENT_MS) return {}

  const lastSeen = stored.seenAt ? Date.parse(stored.seenAt) : Number.NaN
  const continuing = stored.since !== undefined && now - lastSeen < CHURN_CONFIRM_MS
  const at = new Date(now).toISOString()
  return { since: continuing ? stored.since : at, seenAt: at }
}

/** Drop what this module has cached about one connection. */
export function forgetInstanceStatus(instanceId: string): void {
  apiRowCache.delete(instanceId)
  countsCache.delete(instanceId)
}

type InstanceStats = InstanceStatus['stats']

async function readStatus(
  instance: AppInstance,
  options: { counts: boolean, freshCounts?: boolean },
): Promise<InstanceHealth & { stats?: InstanceStats }> {
  const evolution = evolutionClientForInstance(instance)
  const viaSql = canReadMessages(instance)
  const storedChurn: RowChurn = { since: instance.row_churn_since, seenAt: instance.row_churn_seen_at }

  const [live, record, rowWrittenAt, sqlStats] = await Promise.all([
    liveConnectionState(evolution, instance).catch(() => undefined),
    viaSql ? sqlInstanceRecord(instance) : undefined,
    viaSql ? sqlRowWrittenAt(instance) : undefined,
    viaSql && options.counts ? cachedSqlCounts(instance, Boolean(options.freshCounts)) : undefined,
  ])

  let row: EvolutionInstanceRecord | undefined = record
  let stats = sqlStats
  if (!row || (options.counts && !stats)) {
    const api = await cachedApiRow(instance, evolution, live, Boolean(options.freshCounts))
    row ??= api
    if (options.counts) stats ??= api && statsFromApiRow(api)
  }

  if (!row) {
    return options.counts ? { ...emptyStatus(), rowChurn: storedChurn } : { state: 'close', rowChurn: storedChurn }
  }

  if (live === 'open' || row.ownerJid) notePaired(instance)

  const { churn, flapping } = rowChurn(storedChurn, {
    columnOpen: row.connectionStatus === 'open',
    rowWrittenAt,
  })

  return {
    state: live ?? 'unknown',
    sessionLost: row.connectionStatus === 'open' && live !== undefined && live !== 'open',
    flapping,
    rowChurn: churn,
    profileName: row.profileName ?? undefined,
    profilePicUrl: row.profilePicUrl ?? undefined,
    number: row.number ?? row.ownerJid?.split('@')[0],
    ownerJid: row.ownerJid ?? undefined,
    disconnectedAt: row.disconnectionAt ?? undefined,
    ...(options.counts && { stats: stats ?? { messages: 0, chats: 0, contacts: 0 } }),
  }
}

// ── status caches ──────────────────────────────────────────────────────────
// Per process, keyed on the connection id. Several replicas each keep their own,
// which only multiplies a bounded cost; nothing here is a correctness boundary.

const COUNTS_TTL_MS = 5 * 60_000
/** How fresh "fresh" is: two import-screen polls in a row share one count. */
const FRESH_FLOOR_MS = 2_000
const API_ROW_TTL_MS = 5 * 60_000
/** See `cachedApiRow`: a cached column that disagrees with the live state is re-read sooner. */
const API_ROW_DISAGREE_TTL_MS = 60_000

const countsCache = new Map<string, { at: number, stats: InstanceStats }>()
const countsInFlight = new Map<string, Promise<InstanceStats>>()
const apiRowCache = new Map<string, { at: number, row: EvolutionInstanceRow }>()
const apiRowInFlight = new Map<string, Promise<EvolutionInstanceRow | undefined>>()

/** The SQL row, or `undefined` for "use the fallback" — never throws. */
async function sqlInstanceRecord(instance: AppInstance): Promise<EvolutionInstanceRecord | undefined> {
  if (sqlDenied('instance row', instance)) return undefined
  try {
    // No row under this id is not proof the instance is gone — `instance_id`
    // could be stale — so `undefined` sends the caller to the fallback, which
    // asks Evolution by name, as before.
    return await readInstanceRecord(instance)
  }
  catch (error) {
    noteSqlFallback('instance row', instance, error)
    return undefined
  }
}

/**
 * When Evolution last wrote the row, or `undefined` for "cannot tell" — never
 * throws. Uncached, like the row: a loop is told from one reconnect by how
 * recent this is. A missing grant on `"updatedAt"` is logged by
 * `noteSqlFallback` like the other status grants, and costs only flapping
 * detection — there is no fallback for it.
 */
async function sqlRowWrittenAt(instance: AppInstance): Promise<string | undefined> {
  if (sqlDenied('row write time', instance)) return undefined
  try {
    return await readInstanceRowWrittenAt(instance)
  }
  catch (error) {
    noteSqlFallback('row write time', instance, error)
    return undefined
  }
}

/**
 * Per-account counts, cached for `COUNTS_TTL_MS`; `undefined` means "use the
 * fallback". Concurrent callers share one query, as `contactDirectory()` does.
 *
 * A failed recount serves the previous value if there is one — counts that are
 * a few minutes old are still right enough for a dashboard, and falling back to
 * `fetchInstances` is the expensive thing this exists to avoid. Failures are not
 * cached, so the next read retries.
 */
async function cachedSqlCounts(instance: AppInstance, fresh: boolean): Promise<InstanceStats | undefined> {
  const cached = countsCache.get(instance.id)
  const maxAge = fresh ? FRESH_FLOOR_MS : COUNTS_TTL_MS
  if (cached && Date.now() - cached.at < maxAge) return cached.stats
  if (sqlDenied('counts', instance)) return undefined

  let counting = countsInFlight.get(instance.id)
  if (!counting) {
    counting = countInstanceRows(instance)
      .then((stats) => {
        countsCache.set(instance.id, { at: Date.now(), stats })
        return stats
      })
      .finally(() => countsInFlight.delete(instance.id))
    countsInFlight.set(instance.id, counting)
  }

  try {
    return await counting
  }
  catch (error) {
    noteSqlFallback('counts', instance, error)
    return cached?.stats
  }
}

/**
 * `fetchInstances`, cached per connection — the fallback for a connection with
 * no message database, and for one whose SQL read failed.
 *
 * Still the expensive route, but at most once per window per connection rather
 * than once per poll, and for a bring-your-own server the cost lands on that
 * server.
 *
 * **The one place the row can be stale**, and it matters for `sessionLost`,
 * which compares the cached column against the live state. Bounded three ways:
 * our own logout, reconnect and delete drop the entry (`forgetInstanceStatus`);
 * a cached column that disagrees with the live state — a pairing that just
 * finished, a logout from the phone — is re-read after `API_ROW_DISAGREE_TTL_MS`
 * rather than the full window; and `fresh` (the import screen) re-reads it down
 * to the 2 s floor. A dropped session is a lasting disagreement, so it costs one
 * re-read a minute while it lasts.
 *
 * Failures are not cached and answer `undefined`, which the caller reports as
 * it always has.
 */
async function cachedApiRow(
  instance: AppInstance,
  evolution: EvolutionClient,
  live: ConnectionState | undefined,
  fresh: boolean,
): Promise<EvolutionInstanceRow | undefined> {
  const cached = apiRowCache.get(instance.id)
  const disagrees = cached !== undefined && live !== undefined
    && normalizeState(cached.row.connectionStatus) !== live
  const maxAge = fresh ? FRESH_FLOOR_MS : disagrees ? API_ROW_DISAGREE_TTL_MS : API_ROW_TTL_MS
  if (cached && Date.now() - cached.at < maxAge) return cached.row

  const inFlight = apiRowInFlight.get(instance.id)
  if (inFlight) return inFlight

  const fetching = evolution<EvolutionInstanceRow[]>('/instance/fetchInstances')
    .then((rows) => {
      const row = Array.isArray(rows) ? rows.find(r => r?.name === instance.name) ?? rows[0] : undefined
      if (row) apiRowCache.set(instance.id, { at: Date.now(), row })
      return row
    })
    .catch(() => undefined)
    .finally(() => apiRowInFlight.delete(instance.id))

  apiRowInFlight.set(instance.id, fetching)
  return fetching
}

function statsFromApiRow(row: EvolutionInstanceRow): InstanceStats {
  return {
    messages: row._count?.Message ?? 0,
    chats: row._count?.Chat ?? 0,
    contacts: row._count?.Contact ?? 0,
  }
}

/**
 * Say why a status read fell back to `fetchInstances` — once per cause per five
 * minutes, since the sweep and the polls would otherwise repeat it constantly.
 * The fallback keeps the status right, so without this a missing grant would
 * only show up as the database load this change exists to remove.
 *
 * A missing grant (42501) also stops that read being tried for the same five
 * minutes on that connection: it will not fix itself between two polls, and
 * each attempt is an error line in Postgres's own log.
 */
const SQL_FALLBACK_QUIET_MS = 5 * 60_000
const sqlFallbackLoggedAt = new Map<string, number>()
// Not cleared by `forgetInstanceStatus`: a missing grant is about the database
// role, not about anything a logout or reconnect changes.
const sqlDeniedAt = new Map<string, number>()

function sqlDenied(what: string, instance: AppInstance): boolean {
  const at = sqlDeniedAt.get(`${what}:${instance.id}`)
  return at !== undefined && Date.now() - at < SQL_FALLBACK_QUIET_MS
}

function noteSqlFallback(what: string, instance: AppInstance, error: unknown): void {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === '42501') sqlDeniedAt.set(`${what}:${instance.id}`, Date.now())

  const key = `${what}:${String(code ?? 'other')}`
  const last = sqlFallbackLoggedAt.get(key)
  if (last !== undefined && Date.now() - last < SQL_FALLBACK_QUIET_MS) return
  sqlFallbackLoggedAt.set(key, Date.now())

  if (what === 'row write time') {
    // No fallback behind this one, so the usual wording would be untrue.
    if (code === '42501') {
      console.warn(
        '[instances] the Evolution database role cannot read "Instance"."updatedAt", so a '
        + 'WhatsApp reconnect loop is not detected. Add it to the status grants in '
        + 'docs/whatsapp.md "Reading and searching messages".',
      )
      return
    }
    console.error('[instances] could not read when Evolution last wrote an instance row; reconnect-loop detection skipped:', error)
    return
  }

  if (code === '42501') {
    console.warn(
      `[instances] status ${what}: the Evolution database role lacks a grant, so status reads `
      + 'fall back to Evolution\'s fetchInstances (a full "Message" scan, cached per connection). '
      + 'Add the status grants in docs/whatsapp.md "Reading and searching messages".',
    )
    return
  }
  console.error(`[instances] status ${what} could not be read from the Evolution database; using fetchInstances:`, error)
}

/**
 * The state Evolution holds in memory for this instance's socket — the one that
 * is true, see `getInstanceStatus`. An instance Evolution has not loaded at all
 * answers with no state, which reads as `unknown`.
 */
async function liveConnectionState(evolution: EvolutionClient, instance: AppInstance): Promise<ConnectionState> {
  const response = await evolution<{ instance?: { state?: string } }>(
    `/instance/connectionState/${encodeURIComponent(instance.name)}`,
  )
  return normalizeState(response?.instance?.state)
}

/**
 * Bring a dropped session back from its stored credentials, without a QR scan
 * if they still hold.
 *
 * Only one live state has a call that does that safely:
 *
 *   close       `GET /instance/connect`. In `close` Evolution builds a new socket
 *               from the stored credentials.
 *   connecting  nothing — 409. `connect` in this state only returns the cached
 *               QR object, and the other candidate, `restart`, is never sent
 *               (below). A socket that hung while connecting is recovered by
 *               restarting the Evolution service, which is what the refusal says.
 *   unknown     nothing — 409. Evolution has no live socket it will tell us
 *               about; the same restart is the remedy.
 *   open        nothing. This is also the one state in which no call could help
 *               if the socket were in fact dead: Baileys' `end()` returns early
 *               on a socket it already closed.
 *
 * **Never `POST /instance/restart`.** On Baileys, 2.3.7's controller takes a
 * fallback branch (`instance.controller.ts` `restartInstance`) that calls
 * `client.end()` — a close with no status code, which Evolution's own close
 * handler answers by reconnecting — and then calls `connectToWhatsapp` itself.
 * When the close has been processed by then, that is a second `createClient`
 * beside the handler's, and `createClient` does not end the socket it replaces:
 * two sockets on one set of credentials, replacing each other as fast as they
 * can log in. It is a race, unconfirmed as the cause of
 * ju-li/automata-mcp#103, but the loop it can start costs a real number its
 * standing with WhatsApp, and in the order where it does not double up it does
 * nothing a service restart would not.
 *
 * `connect` can still leave the account needing a QR — rejected credentials
 * make Evolution emit one — which the caller sees as a state it can pair from.
 *
 * The route catches its own failures and answers **200** with
 * `{ error: true, message }`, so a resolved request is not a success.
 */
export async function reconnectInstance(instance: AppInstance): Promise<ConnectionState> {
  const evolution = evolutionClientForInstance(instance)
  const name = encodeURIComponent(instance.name)

  const before = await liveConnectionState(evolution, instance)
  if (before === 'open') return before
  if (before !== 'close') {
    throw createError({
      statusCode: 409,
      statusMessage: before === 'connecting'
        ? 'Evolution is still connecting this account. If it stays that way, restart the Evolution service — that reconnects it without a new QR scan.'
        : 'Evolution has no live connection for this account. Restarting the Evolution service reconnects it without a new QR scan.',
    })
  }
  forgetInstanceStatus(instance.id)

  const response = await evolution<EvolutionActionResponse>(`/instance/connect/${name}`)

  if (response?.error) {
    // Handled, so Nitro would log nothing; the message is Evolution's own.
    console.error(
      `[instances] reconnect of ${instance.id} (${instance.name}) from state ${before} failed: ${response.message}`,
    )
    throw createError({ statusCode: 502, statusMessage: 'Evolution could not reconnect this account' })
  }

  return await liveConnectionState(evolution, instance)
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
    const state = normalizeState(response.instance.state)
    // The pairing page's poll is the first thing to see a scan land.
    if (state === 'open') notePaired(instance)
    return { state }
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
  // Whatever happens below, the cached row (fallback path) predates it.
  forgetInstanceStatus(instance.id)
  try {
    await evolution(`/instance/logout/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
  } catch (error) {
    if (httpStatusOf(error) === 400) return
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
 * the app's row. `mcp_tokens` rows cascade away with it, so every token
 * for this account stops authenticating.
 *
 * Evolution is torn down first — if that fails we keep the row, because a row
 * pointing at a live instance is recoverable and a live instance nobody has a
 * record of is not. Evolution logs the instance out itself if it is connected.
 *
 * A Postgres connection owns nothing outside this app: there is no remote
 * resource to release, only a local pool to close.
 *
 * `event` is the hosted outbox row for the delete, written in the same
 * transaction as the row delete.
 */
export async function deleteInstance(
  instance: AppInstance,
  options: { event?: HostedEvent } = {},
): Promise<void> {
  // Release whatever this kind holds, then delete the row — once, for every
  // kind. The ordering is the rule stated above and it is the same either way:
  // if releasing throws, the row survives and still points at the thing.
  const kind = instanceKind(instance)

  if (kind === 'telegram') {
    // Logs the account out on Telegram's side and deletes its synced chats.
    await deleteTelegramSession(instance)
  }
  else if (kind === 'postgres') {
    await closeSqlPool(instance)
  }
  else if (kind === 'imap') {
    // Nothing remote to release — the mailbox is the user's. The synced
    // headers go with the row (ON DELETE CASCADE); the live connection is ours.
    await closeImapFor(instance)
  }
  else if (kind === 'whatsapp') {
    // A connection on its own server may hold a pool onto that server's message
    // database. Keyed on the row, so it outlives the row unless dropped here.
    await closeKeyedPool(`evo:${instance.id}`)
    forgetInstanceStatus(instance.id)

    // Uses the same server the instance was created on, with that server's own
    // global key when it brought one.
    //
    // **Credentials missing is not a reason to refuse the delete.** With the
    // Evolution variables now optional, and with a row's `base_url` able to stop
    // matching a reconfigured deployment, `evolutionAdminCredentials` can
    // return undefined for a row that already exists — and gating the row
    // deletion on that would leave a connection, and its tokens, permanently
    // undeletable. Better a logged orphan on the Evolution server than a
    // record the owner cannot get rid of.
    const creds = evolutionAdminCredentials(instance)

    if (!creds) {
      console.error(
        `[instances] deleting ${instance.id} (${instance.name}) without tearing down its Evolution `
        + 'instance: no global key is available for its server. It may need removing there by hand.',
      )
    }
    else {
      try {
        await createEvolutionClient(creds)(`/instance/delete/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
      } catch (error) {
        // A 404 means Evolution has already lost it; carry on and clean up our row.
        if (httpStatusOf(error) !== 404) throw error
      }
    }
  }
  else {
    assertNever(kind, 'connection kind')
  }

  // The outbox event commits with the row delete, so it exists exactly when the
  // connection is gone.
  const sql = await appDb()
  await sql.begin(async (tx) => {
    await tx`DELETE FROM app.instances WHERE id = ${instance.id}`
    if (options.event) await recordHostedEvent(tx, options.event)
  })
}

// ── internals ──────────────────────────────────────────────────────────────

/** One row of `fetchInstances` — the record `readInstanceRecord` reads, plus Prisma's counts. */
interface EvolutionInstanceRow extends EvolutionInstanceRecord {
  name?: string
  _count?: { Message?: number, Chat?: number, Contact?: number }
}

/** What `connect` and `restart` answer with when they failed — as a 200. */
interface EvolutionActionResponse {
  error?: boolean
  message?: string
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

/**
 * Live state for one connection, whatever kind it is.
 *
 * The branch lives here rather than in the routes because both `/api/instances`
 * and `/api/instances/:id` were carrying their own copy of it, each choosing
 * between `getPostgresHealth` and `getInstanceStatus` and reshaping the result.
 * `instanceKind()` is the intended dispatch point for this; a route handler is
 * not, and two copies of a dispatch are two things to update when a third kind
 * arrives.
 *
 * `tolerant` is the one difference between the two callers, and it is real. A
 * listing must not lose every row because one is half-provisioned — an
 * unprovisioned WhatsApp row makes `evolutionClientForInstance` throw 409 —
 * whereas asking for one connection by id should say so. Note that neither
 * `getPostgresHealth` nor `getInstanceStatus` throws for a *backend* failure:
 * both already answer with a `close`/`unknown` state, which is what the
 * dashboard needs in order to render at all.
 *
 * A row that throws reports **`unknown`, not `close`**, and the two are not
 * interchangeable: `close` reads to a person as "not paired, scan a QR code",
 * which is a wrong instruction for a connection whose credentials never
 * existed. `unknown` says the state could not be established, which is the
 * truth. `emptyStatus()` is deliberately not reused here for that reason.
 */
export type ConnectionStateReport =
  | { state: ConnectionState, detail?: string, error?: string, warning?: string }
  | InstanceStatus
  | TelegramStatus

export async function connectionState(
  instance: AppInstance,
  options: { tolerant?: boolean, freshCounts?: boolean } = {},
): Promise<ConnectionStateReport> {
  const kind = instanceKind(instance)
  switch (kind) {
    case 'postgres': {
      const health = await getPostgresHealth(instance)
      return { state: health.state, detail: health.detail, error: health.error, warning: health.warning }
    }
    case 'whatsapp':
      if (!options.tolerant) return await getInstanceStatus(instance, { freshCounts: options.freshCounts })
      return await getInstanceStatus(instance, { freshCounts: options.freshCounts }).catch(() => unknownStatus())
    case 'telegram':
      // Never throws: a bridge that cannot be asked answers `unknown`, for the
      // reason given above.
      return await getTelegramStatus(instance)
    case 'imap':
      return await getImapHealth(instance)
    default:
      return assertNever(kind, 'connection kind')
  }
}

/** Evolution answered, but not about an account it recognises. */
function emptyStatus(): InstanceStatus {
  return { state: 'close', stats: { messages: 0, chats: 0, contacts: 0 } }
}

/** Evolution could not be asked at all — see `connectionState`. */
function unknownStatus(): InstanceStatus {
  return { state: 'unknown', stats: { messages: 0, chats: 0, contacts: 0 } }
}

function normalizeState(state: string | undefined): ConnectionState {
  return state === 'open' || state === 'connecting' || state === 'close' ? state : 'unknown'
}
