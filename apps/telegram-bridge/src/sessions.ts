import QRCode from 'qrcode'
import { Api, Logger, TelegramClient, sessions } from 'teleproto'
import type { BridgeConfig } from './config.ts'
import { digestsEqual, hashKey, mintKey, seal, sessionContext, unseal, webhookContext } from './crypto.ts'
import type { Sql } from './db.ts'
import { HttpError, describeError } from './http-error.ts'
import { SessionLocks } from './locks.ts'
import { deliverWebhook } from './webhook.ts'

/**
 * Every Telegram session this process runs.
 *
 * **State is read off the live client, never off a column.** The row says
 * whether a session *exists* (`session_enc`) and whether Telegram *revoked* it;
 * whether it is connected right now is only knowable from the client. That is
 * the lesson of the WhatsApp side, where a status column said "open" for a week
 * over a dead socket.
 *
 * A session moves through:
 *
 *   unlinked  no session_enc. `pair()` starts a QR flow.
 *   pairing   a QR flow is running (phase `qr`, then `password` if the account
 *             has two-step verification). Bounded by PAIRING_WINDOW_MS.
 *   linked    session_enc set; this process holds its lock and runs a client.
 *   revoked   Telegram refused the session. session_enc is cleared; only a new
 *             pairing brings it back.
 *
 * Stopping the process disconnects clients and never logs them out: a redeploy
 * must not unlink anybody.
 */

export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

/** teleproto's LogLevel, reached through the exported Logger rather than a deep import. */
type LogLevel = NonNullable<ConstructorParameters<typeof Logger>[0]>

export interface SessionState {
  state: ConnectionState
  /** Linked, and the connection to Telegram is down. Reconnect, no scan. */
  sessionLost: boolean
  /** Telegram stopped accepting this session. Only pairing again fixes it. */
  revoked: boolean
  pairing?: 'qr' | 'password'
  /** Telegram's hint for the two-step verification password, if the account set one. */
  passwordHint?: string
  /** The last password submitted for this pairing was wrong. */
  passwordRejected?: boolean
  /** Another bridge process holds this session; this one cannot say how it is. */
  heldElsewhere: boolean
  me?: { id: string, username?: string, name?: string, phone?: string }
  lastError?: string
  stats: { chats: number, messages: number }
}

export interface PairingQr {
  /** A PNG data URL of `tg://login?token=…`. */
  dataUrl: string
  expiresAt: string
}

interface PairingFlow {
  abort: AbortController
  phase: 'qr' | 'password'
  qr?: PairingQr
  hint?: string
  passwordRejected: boolean
  /** Set while Telegram is waiting for the password; cleared once one is handed over. */
  submit?: (password: string) => void
}

interface Runtime {
  id: string
  client?: TelegramClient
  /** The last probe of the client answered. */
  healthy: boolean
  revoked: boolean
  heldElsewhere: boolean
  pairing?: PairingFlow
  lastError?: string
  /** Signature of the last state sent to the webhook, to send each change once. */
  lastPublished?: string
}

interface SessionRow {
  id: string
  session_enc: string | null
  me_id: string | null
  me_username: string | null
  me_name: string | null
  me_phone: string | null
  revoked_at: Date | null
  webhook_url: string | null
  webhook_headers_enc: string | null
}

/** How long a QR flow may wait for a scan (and a password) before it is abandoned. */
const PAIRING_WINDOW_MS = 5 * 60_000
const HEARTBEAT_MS = 30_000
const PROBE_TIMEOUT_MS = 20_000
const DISPOSE_TIMEOUT_MS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * RPC errors that mean the auth key is dead for good. Matched on the error code
 * rather than on teleproto's error classes, which a library bump can rename.
 *
 * AUTH_KEY_DUPLICATED belongs here: Telegram invalidates a key it saw used from
 * two connections at once, which is what the session locks exist to prevent.
 */
const REVOKED = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
])

export class SessionManager {
  private readonly sql: Sql
  private readonly config: BridgeConfig
  private readonly locks: SessionLocks
  private readonly runtimes = new Map<string, Runtime>()
  private heartbeat: NodeJS.Timeout | undefined
  private ticking = false
  private stopping = false

  constructor(sql: Sql, config: BridgeConfig) {
    this.sql = sql
    this.config = config
    this.locks = new SessionLocks(config.databaseUrl, ids => this.onLocksLost(ids))
  }

  async start(): Promise<void> {
    this.locks.start()
    await this.tick()
    this.heartbeat = setInterval(() => { void this.tick() }, HEARTBEAT_MS)
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    clearInterval(this.heartbeat)
    for (const rt of this.runtimes.values()) {
      rt.pairing?.abort.abort()
      await this.dispose(rt)
    }
    await this.locks.close()
  }

  // ── requests ───────────────────────────────────────────────────────────────

  async create(name: string): Promise<{ id: string, name: string, apiKey: string }> {
    const apiKey = mintKey('tgs_')
    try {
      const [row] = await this.sql<{ id: string }[]>`
        INSERT INTO sessions (name, api_key_hash) VALUES (${name}, ${hashKey(apiKey)}) RETURNING id`
      return { id: row!.id, name, apiKey }
    }
    catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'A session with that name already exists.')
      }
      throw error
    }
  }

  /** Whether `presented` is this session's key. Unknown ids answer false, like wrong keys. */
  async authorize(id: string, presented: string | undefined): Promise<boolean> {
    if (!presented || !UUID.test(id)) return false
    const [row] = await this.sql<{ api_key_hash: string }[]>`SELECT api_key_hash FROM sessions WHERE id = ${id}`
    return row !== undefined && digestsEqual(row.api_key_hash, hashKey(presented))
  }

  async state(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const [counts] = await this.sql<{ chats: string, messages: string }[]>`
      SELECT (SELECT count(*) FROM chats WHERE session_id = ${id}) AS chats,
             (SELECT count(*) FROM messages WHERE session_id = ${id} AND deleted_at IS NULL) AS messages`
    return describe(this.runtime(id), row, {
      chats: Number(counts?.chats ?? 0),
      messages: Number(counts?.messages ?? 0),
    })
  }

  /**
   * The QR code for a pairing in progress. Never starts one and never asks
   * Telegram for a token: a client polling this cannot turn into a stream of
   * login attempts, which is the failure the WhatsApp QR poll has to be kept
   * away from by hand.
   */
  async qr(id: string): Promise<{ state: SessionState, qr?: PairingQr }> {
    const state = await this.state(id)
    return { state, qr: this.runtimes.get(id)?.pairing?.qr }
  }

  /** Start a QR flow. Idempotent while one is already running. */
  async pair(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const rt = this.runtime(id)
    if (rt.pairing) return await this.state(id)
    if (row.session_enc) {
      throw new HttpError(409, 'This session is already linked to a Telegram account. Log it out before pairing again.')
    }

    if (!(await this.locks.acquire(id))) {
      rt.heldElsewhere = true
      throw new HttpError(409, 'Another bridge process holds this session. Only one process may run a session at a time.')
    }
    rt.heldElsewhere = false
    // Re-checked after the await: two requests can both get past the first check.
    if (rt.pairing) return await this.state(id)

    const flow: PairingFlow = { abort: new AbortController(), phase: 'qr', passwordRejected: false }
    rt.pairing = flow
    rt.revoked = false
    rt.lastError = undefined

    const timer = setTimeout(() => flow.abort.abort(), PAIRING_WINDOW_MS)
    timer.unref()
    void this.runPairing(rt, flow).finally(() => clearTimeout(timer))

    this.publish(rt)
    return await this.state(id)
  }

  /**
   * Hand the two-step verification password to the pairing waiting for it.
   *
   * It passes straight through to Telegram's SRP check: never stored, never
   * logged, and not kept on the flow after it is handed over.
   */
  async submitPassword(id: string, password: string): Promise<SessionState> {
    await this.row(id)
    const flow = this.runtimes.get(id)?.pairing
    const submit = flow?.phase === 'password' ? flow.submit : undefined
    if (!flow || !submit) {
      throw new HttpError(409, 'This session is not waiting for a two-step verification password.')
    }
    flow.submit = undefined
    flow.passwordRejected = false
    submit(password)
    return await this.state(id)
  }

  /**
   * Unlink: log out on Telegram's side where possible, then forget the session.
   *
   * Forgetting happens even if Telegram could not be reached. The alternative is
   * a session nobody can remove; what is left over is an entry in the account's
   * Telegram → Devices list, which the owner can terminate there.
   */
  async logout(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const rt = this.runtime(id)
    rt.pairing?.abort.abort()

    if (row.session_enc) {
      if (!(await this.locks.acquire(id))) {
        rt.heldElsewhere = true
        throw new HttpError(409, 'Another bridge process holds this session. Log it out there.')
      }
      rt.heldElsewhere = false

      let saved: string | undefined
      try {
        saved = rt.client ? undefined : this.openSession(id, row.session_enc)
      }
      catch {
        console.error(`[sessions] ${id}: the stored session could not be decrypted, so it cannot be logged out on Telegram's side; forgetting it anyway`)
      }

      if (rt.client || saved !== undefined) {
        try {
          if (!rt.client) {
            rt.client = this.newClient(new sessions.StringSession(saved))
            await withTimeout(rt.client.connect(), PROBE_TIMEOUT_MS)
          }
          await withTimeout(rt.client.logOut(), PROBE_TIMEOUT_MS)
        }
        catch (error) {
          if (!isRevocation(error)) {
            console.error(`[sessions] ${id}: Telegram-side logout failed (${describeError(error)}); forgetting the session anyway`)
          }
        }
      }
    }

    await this.dispose(rt)
    await this.sql`
      UPDATE sessions
      SET session_enc = NULL, authorized_at = NULL, revoked_at = NULL,
          me_id = NULL, me_username = NULL, me_name = NULL, me_phone = NULL, updated_at = now()
      WHERE id = ${id}`
    rt.revoked = false
    rt.lastError = undefined
    await this.locks.release(id)
    this.publish(rt)
    return await this.state(id)
  }

  /**
   * Drop the client and connect again from the stored session. Answers at once;
   * the connection is made in the background and shows up in `state`.
   */
  async reconnect(id: string): Promise<SessionState> {
    const row = await this.row(id)
    const rt = this.runtime(id)
    if (!row.session_enc) {
      throw new HttpError(409, row.revoked_at
        ? 'Telegram no longer accepts this session. It has to be paired again.'
        : 'This session is not linked to a Telegram account.')
    }
    if (!(await this.locks.acquire(id))) {
      rt.heldElsewhere = true
      throw new HttpError(409, 'Another bridge process holds this session.')
    }
    rt.heldElsewhere = false

    await this.dispose(rt)
    void this.resume(rt, row).finally(() => this.publish(rt))
    return await this.state(id)
  }

  /** Log out, then delete the row and everything synced for it. */
  async remove(id: string): Promise<void> {
    await this.row(id)
    try {
      await this.logout(id)
    }
    catch (error) {
      if (!(error instanceof HttpError)) throw error
      // Held by another process: it drops the client on its next heartbeat,
      // when it finds the row gone.
      console.error(`[sessions] ${id}: deleting without a Telegram-side logout: ${error.message}`)
    }
    await this.sql`DELETE FROM sessions WHERE id = ${id}`
    this.runtimes.delete(id)
  }

  async setWebhook(id: string, url: string | null, headers: Record<string, string>): Promise<void> {
    await this.row(id)
    const sealed = url && Object.keys(headers).length > 0
      ? seal(this.config.sealKey, JSON.stringify(headers), webhookContext(id))
      : null
    await this.sql`
      UPDATE sessions SET webhook_url = ${url}, webhook_headers_enc = ${sealed}, updated_at = now()
      WHERE id = ${id}`
    const rt = this.runtime(id)
    // Send the current state to the new destination, even if it has not changed.
    rt.lastPublished = undefined
    this.publish(rt)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private async runPairing(rt: Runtime, flow: PairingFlow): Promise<void> {
    const session = new sessions.StringSession('')
    const client = this.newClient(session)
    const { signal } = flow.abort

    try {
      await client.connect()
      const user = await client.signInUserWithQrCode(
        { apiId: this.config.apiId, apiHash: this.config.apiHash },
        {
          abortSignal: signal,
          qrCode: async ({ token, expires }) => {
            const url = `tg://login?token=${token.toString('base64url')}`
            flow.qr = {
              dataUrl: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 320 }),
              expiresAt: new Date(expires * 1000).toISOString(),
            }
            flow.phase = 'qr'
          },
          password: hint => new Promise<string>((resolve, reject) => {
            if (signal.aborted) return reject(abortError())
            flow.phase = 'password'
            flow.qr = undefined
            flow.hint = hint || undefined
            flow.submit = resolve
            signal.addEventListener('abort', () => reject(abortError()), { once: true })
            this.publish(rt)
          }),
          // Called for failures inside the password step. A wrong password is
          // retried (teleproto asks for it again); anything else ends the flow.
          onError: async (error) => {
            if (describeError(error) === 'PASSWORD_HASH_INVALID') {
              flow.passwordRejected = true
              return false
            }
            return true
          },
        },
      )
      if (signal.aborted) throw abortError()

      await this.sql`
        UPDATE sessions
        SET session_enc = ${seal(this.config.sealKey, session.save(), sessionContext(rt.id))},
            authorized_at = now(), revoked_at = NULL, updated_at = now()
        WHERE id = ${rt.id}`
      await this.recordMe(rt.id, user)

      rt.client = client
      rt.healthy = true
      rt.revoked = false
      rt.lastError = undefined
      console.info(`[sessions] ${rt.id}: linked`)
    }
    catch (error) {
      await destroyClient(client)
      rt.lastError = signal.aborted
        ? 'Pairing was not completed in time, or was cancelled. Start it again to get a new QR code.'
        : describeError(error)
      if (!signal.aborted) console.error(`[sessions] ${rt.id}: pairing failed: ${rt.lastError}`)
      await this.locks.release(rt.id)
    }
    finally {
      rt.pairing = undefined
      this.publish(rt)
    }
  }

  /** Connect a linked session from its stored string. */
  private async resume(rt: Runtime, row: SessionRow): Promise<void> {
    if (rt.client || rt.pairing || !row.session_enc || this.stopping) return
    if (!(await this.locks.acquire(rt.id))) {
      rt.heldElsewhere = true
      return
    }
    rt.heldElsewhere = false

    let saved: string
    try {
      saved = this.openSession(rt.id, row.session_enc)
    }
    catch {
      rt.lastError = 'The stored session could not be decrypted. Has TELEGRAM_SESSION_ENCRYPTION_KEY changed?'
      console.error(`[sessions] ${rt.id}: ${rt.lastError}`)
      return
    }

    const client = this.newClient(new sessions.StringSession(saved))
    rt.client = client
    try {
      await withTimeout(client.connect(), PROBE_TIMEOUT_MS)
      const me = await withTimeout(client.getMe(), PROBE_TIMEOUT_MS)
      rt.healthy = true
      rt.lastError = undefined
      await this.recordMe(rt.id, me)
    }
    catch (error) {
      if (isRevocation(error)) {
        await this.markRevoked(rt, error)
        return
      }
      // Transient. Drop the client but keep the lock: the next heartbeat tries
      // again, and this process is still the one entitled to.
      rt.lastError = describeError(error)
      console.error(`[sessions] ${rt.id}: could not connect: ${rt.lastError}`)
      await this.dispose(rt)
    }
  }

  private async probe(rt: Runtime): Promise<void> {
    const client = rt.client
    if (!client || rt.pairing) return
    try {
      await withTimeout(client.invoke(new Api.updates.GetState()), PROBE_TIMEOUT_MS)
      rt.healthy = true
      rt.lastError = undefined
    }
    catch (error) {
      if (isRevocation(error)) return await this.markRevoked(rt, error)
      rt.healthy = false
      rt.lastError = describeError(error)
    }
  }

  private async markRevoked(rt: Runtime, error: unknown): Promise<void> {
    const reason = describeError(error)
    console.error(`[sessions] ${rt.id}: Telegram no longer accepts this session (${reason}); it must be paired again`)
    await this.dispose(rt)
    await this.sql`UPDATE sessions SET session_enc = NULL, revoked_at = now(), updated_at = now() WHERE id = ${rt.id}`
    rt.revoked = true
    rt.lastError = reason
    await this.locks.release(rt.id)
    this.publish(rt)
  }

  /**
   * The heartbeat: converge what this process runs on what the table says.
   * Connects linked sessions it does not run yet (including ones another process
   * released), probes the ones it does, and drops clients whose row went away.
   */
  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      const rows = await this.sql<SessionRow[]>`
        SELECT id, session_enc, me_id, me_username, me_name, me_phone, revoked_at, webhook_url, webhook_headers_enc
        FROM sessions`
      const byId = new Map(rows.map(row => [row.id, row]))

      for (const rt of [...this.runtimes.values()]) {
        const row = byId.get(rt.id)
        if (row?.session_enc || rt.pairing) continue
        // Deleted, or logged out by another process.
        if (rt.client) await this.dispose(rt)
        await this.locks.release(rt.id)
        if (!row) this.runtimes.delete(rt.id)
      }

      for (const row of rows) {
        const rt = this.runtime(row.id)
        if (row.revoked_at) rt.revoked = true
        if (rt.client) await this.probe(rt)
        else await this.resume(rt, row)
        this.publish(rt)
      }
    }
    catch (error) {
      console.error(`[sessions] heartbeat failed: ${describeError(error)}`)
    }
    finally {
      this.ticking = false
    }
  }

  private onLocksLost(ids: string[]): void {
    for (const id of ids) {
      const rt = this.runtimes.get(id)
      if (!rt) continue
      console.error(`[sessions] ${id}: lost its session lock; disconnecting until it is taken again`)
      rt.pairing?.abort.abort()
      void this.dispose(rt).then(() => this.publish(rt))
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id)
    if (!rt) {
      rt = { id, healthy: false, revoked: false, heldElsewhere: false }
      this.runtimes.set(id, rt)
    }
    return rt
  }

  private async row(id: string): Promise<SessionRow> {
    const row = UUID.test(id)
      ? (await this.sql<SessionRow[]>`
          SELECT id, session_enc, me_id, me_username, me_name, me_phone, revoked_at, webhook_url, webhook_headers_enc
          FROM sessions WHERE id = ${id}`)[0]
      : undefined
    if (!row) throw new HttpError(404, 'No such session.')
    return row
  }

  private openSession(id: string, sealed: string): string {
    return unseal(this.config.sealKey, sealed, sessionContext(id))
  }

  private newClient(session: sessions.StringSession): TelegramClient {
    const logger = new Logger('warn' as LogLevel)
    logger.handler = (record) => {
      const level = String(record.level)
      if (level !== 'error' && level !== 'warn') return
      console.error(`[teleproto] ${level}: ${String(record.message).slice(0, 300)}`)
    }
    return new TelegramClient(session, this.config.apiId, this.config.apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60,
      testServers: this.config.testServers,
      baseLogger: logger,
      deviceModel: 'Automata MCP',
      systemVersion: 'bridge',
      appVersion: '1.0',
    })
  }

  private async dispose(rt: Runtime): Promise<void> {
    const client = rt.client
    rt.client = undefined
    rt.healthy = false
    if (client) await destroyClient(client)
  }

  private async recordMe(id: string, user: unknown): Promise<void> {
    if (!(user instanceof Api.User)) return
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || null
    await this.sql`
      UPDATE sessions
      SET me_id = ${user.id.toString()}, me_username = ${user.username ?? null},
          me_name = ${name}, me_phone = ${user.phone ?? null}, updated_at = now()
      WHERE id = ${id}`
  }

  /** Send a state change to the session's webhook, once per change. Never throws. */
  private publish(rt: Runtime): void {
    void (async () => {
      try {
        const [row] = await this.sql<SessionRow[]>`
          SELECT id, session_enc, me_id, me_username, me_name, me_phone, revoked_at, webhook_url, webhook_headers_enc
          FROM sessions WHERE id = ${rt.id}`
        if (!row?.webhook_url) return

        const state = describe(rt, row, { chats: 0, messages: 0 })
        const signature = [state.state, state.sessionLost, state.revoked, state.pairing ?? ''].join('|')
        if (signature === rt.lastPublished) return
        rt.lastPublished = signature

        const headers = row.webhook_headers_enc
          ? JSON.parse(unseal(this.config.sealKey, row.webhook_headers_enc, webhookContext(rt.id))) as Record<string, string>
          : {}
        await deliverWebhook(row.webhook_url, headers, {
          event: 'connection.update',
          sessionId: rt.id,
          state: state.state,
          sessionLost: state.sessionLost,
          revoked: state.revoked,
        })
      }
      catch (error) {
        console.error(`[webhook] ${rt.id}: ${describeError(error)}`)
      }
    })()
  }
}

function describe(rt: Runtime, row: SessionRow, stats: SessionState['stats']): SessionState {
  const base = {
    sessionLost: false,
    revoked: rt.revoked || row.revoked_at !== null,
    heldElsewhere: rt.heldElsewhere,
    lastError: rt.lastError,
    stats,
    me: row.me_id
      ? {
          id: row.me_id,
          username: row.me_username ?? undefined,
          name: row.me_name ?? undefined,
          phone: row.me_phone ?? undefined,
        }
      : undefined,
  }

  if (rt.pairing) {
    return {
      ...base,
      state: 'connecting',
      pairing: rt.pairing.phase,
      passwordHint: rt.pairing.phase === 'password' ? rt.pairing.hint : undefined,
      passwordRejected: rt.pairing.passwordRejected || undefined,
    }
  }
  if (!row.session_enc) return { ...base, state: 'close' }
  if (rt.heldElsewhere) return { ...base, state: 'unknown' }
  if (rt.client?.connected && rt.healthy) return { ...base, state: 'open' }
  return { ...base, state: 'connecting', sessionLost: true }
}

function isRevocation(error: unknown): boolean {
  return REVOKED.has(describeError(error))
}

function abortError(): Error {
  const error = new Error('pairing aborted')
  error.name = 'AbortError'
  return error
}

async function destroyClient(client: TelegramClient): Promise<void> {
  await withTimeout(client.destroy(), DISPOSE_TIMEOUT_MS).catch(() => {})
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}
