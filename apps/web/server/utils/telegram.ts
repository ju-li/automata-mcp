import type { AppInstance } from './pocketbase'
import type { McpAuth } from './mcp-auth'
import type { ConnectionState } from '#shared/connection'

/**
 * The one client for a Telegram bridge (apps/telegram-bridge). The Telegram
 * counterpart of `evolution.ts`, with the same boundary:
 *
 *   admin     the bridge's global key. Creates and deletes sessions, nothing
 *             else. Not used by anything in this file.
 *   session   the per-session key the bridge issued, on the row's `api_key`.
 *             State, resolve and send — every call made on a user's behalf.
 *
 * And the same cut across both: a base URL that is not this deployment's
 * `NUXT_TELEGRAM_URL` came from a user, so it is host-guarded on every request.
 *
 * Reading chats does not go through here. Messages are read from the bridge's
 * database, as `evolution-db.ts` reads Evolution's — see `telegram-db.ts`.
 */

export interface TelegramCredentials {
  baseUrl: string
  /** The bridge's per-session key. Opens only this session. */
  apiKey: string
  /** The bridge's id for this session (`instances.instance_id`). */
  sessionId: string
  /** True when `baseUrl` is not the bridge this deployment is configured with. */
  userSupplied: boolean
}

/**
 * Whether this connection lives on the bridge this deployment configured.
 *
 * The single test, as `onDeploymentServer` is for Evolution: a row carrying its
 * own admin key is definitively its own bridge, and so is one pointing anywhere
 * other than `NUXT_TELEGRAM_URL`. Origins are compared the way
 * `sameEvolutionServer` compares them, so a trailing slash does not turn a
 * deployment connection into a guarded one.
 */
export function onDeploymentBridge(instance: Pick<AppInstance, 'admin_key' | 'base_url'>): boolean {
  if (instance.admin_key) return false
  const configUrl = useRuntimeConfig().telegramUrl
  if (!instance.base_url || !configUrl) return true
  return sameEvolutionServer(instance.base_url, configUrl)
}

/**
 * Credentials for one Telegram connection.
 *
 * There is deliberately NO fallback to the bridge's admin key, and `admin_key`
 * is not in the picked type at all: that key creates and deletes every session
 * on its bridge, and a token holder must never be one missing field away from
 * it. A row without its session key or session id answers undefined, and the
 * caller refuses.
 */
export function telegramCredentialsForInstance(
  instance: Pick<AppInstance, 'base_url' | 'api_key' | 'instance_id'>,
): TelegramCredentials | undefined {
  const configUrl = useRuntimeConfig().telegramUrl
  const baseUrl = instance.base_url || configUrl
  if (!baseUrl || !instance.api_key || !instance.instance_id) return undefined
  return {
    baseUrl,
    apiKey: instance.api_key,
    sessionId: instance.instance_id,
    userSupplied: !sameEvolutionServer(baseUrl, configUrl),
  }
}

/** The bridge's `GET /sessions/:id/state`, as far as this app reads it. */
interface BridgeSessionState {
  state: ConnectionState
  sessionLost: boolean
  revoked: boolean
  pairing?: 'qr' | 'password'
  heldElsewhere: boolean
  me?: { id: string, username?: string, name?: string, phone?: string }
  lastError?: string
  stats: { chats: number, messages: number }
  sync: { backfilling: boolean, pausedUntil?: string, dialogsSyncedAt?: string, pendingBackfill: number }
}

// Type aliases rather than interfaces: a tool may return these, and an interface
// has no implicit index signature.
export type BridgeResolved = {
  chatId: string
  type: string
  title: string | null
  username: string | null
  known: boolean
}

export type BridgeSent = {
  chatId: string
  messageId: number
  date: string
}

export function createTelegramBridge(creds: TelegramCredentials) {
  const client = $fetch.create({
    baseURL: creds.baseUrl,
    headers: { authorization: `Bearer ${creds.apiKey}` },
    retry: 0,
    timeout: 20_000,
    // Same check-not-pin caveat as `createEvolutionClient`: `$fetch` resolves DNS
    // itself, so this narrows the rebinding window rather than closing it.
    async onRequest({ options }) {
      if (!creds.userSupplied) return
      await assertPublicUrl(creds.baseUrl, 'Telegram bridge URL')
      options.redirect = 'error'
    },
  })
  const session = `/sessions/${encodeURIComponent(creds.sessionId)}`

  return {
    state: () => client<BridgeSessionState>(`${session}/state`),
    resolve: (query: string) => client<BridgeResolved>(`${session}/resolve`, { method: 'POST', body: { query } }),
    send: (chatId: string, text: string) => client<BridgeSent>(`${session}/send`, { method: 'POST', body: { chatId, text } }),
  }
}

export type TelegramBridge = ReturnType<typeof createTelegramBridge>

/**
 * For MCP tool handlers. Reads `event.context.mcpAuth` and nothing else, like
 * `useEvolutionClient()`, and fails closed on anything that is not a Telegram
 * connection.
 */
export function useTelegramBridge(): TelegramBridge {
  const event = useEvent()
  const auth = event.context.mcpAuth as McpAuth | undefined
  if (!auth || auth.kind !== 'telegram') {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return createTelegramBridge(auth.telegram)
}

/**
 * Turn a failed bridge call into an answer a caller can act on.
 *
 * The bridge's 4xx bodies are written for callers — "not connected", "send to
 * -100… instead", Telegram's own refusal code — so those pass through with their
 * status. Anything else, including a 401 that means this row's session key is
 * wrong, is this deployment's problem: logged, because a handled error is
 * invisible to Nitro, and answered as 503.
 */
export function relayBridgeError(error: unknown, action: string): never {
  const status = httpStatusOf(error)
  const message = (error as { data?: { error?: unknown } } | undefined)?.data?.error
  if (status !== undefined && [400, 404, 409, 422, 429].includes(status) && typeof message === 'string') {
    throw createError({ statusCode: status, message })
  }
  console.error(`[telegram] could not ${action}: bridge answered ${status ?? (error as Error | undefined)?.message ?? 'nothing'}`)
  throw createError({
    statusCode: 503,
    message: `Could not ${action}: the Telegram bridge for this connection did not answer.`,
  })
}

// A type alias rather than an interface: MCP tool handlers may return it, and
// interfaces carry no implicit index signature.
export type TelegramStatus = {
  /** The bridge's live client state, never a stored column. */
  state: ConnectionState
  /** Linked, and the connection to Telegram dropped. Reconnect; no scan. */
  sessionLost?: boolean
  /** Telegram ended the session (Telegram → Devices, or the account). Link again by QR. */
  revoked?: boolean
  pairing?: 'qr' | 'password'
  telegramUserId?: string
  profileName?: string
  username?: string
  number?: string
  error?: string
  stats: { messages: number, chats: number }
  sync?: { backfilling: boolean, pendingBackfill: number, dialogsSyncedAt?: string, pausedUntil?: string }
}

/**
 * A Telegram connection's state, from its bridge. Never throws: a bridge that
 * cannot be asked is `unknown` — not `close`, which reads as "not linked" and is
 * the wrong instruction — so the listing and the dashboard always render.
 */
export async function getTelegramStatus(instance: AppInstance): Promise<TelegramStatus> {
  const empty = { messages: 0, chats: 0 }
  const creds = telegramCredentialsForInstance(instance)
  if (!creds) {
    return { state: 'unknown', error: 'This Telegram connection is not fully provisioned.', stats: empty }
  }

  let bridge: BridgeSessionState
  try {
    bridge = await createTelegramBridge(creds).state()
  }
  catch (error) {
    console.error(`[telegram] could not read connection ${instance.id} from its bridge: ${httpStatusOf(error) ?? (error as Error | undefined)?.message}`)
    return { state: 'unknown', error: 'Could not reach the Telegram bridge for this connection.', stats: empty }
  }

  return {
    state: bridge.state,
    ...(bridge.sessionLost && { sessionLost: true }),
    ...(bridge.revoked && { revoked: true }),
    ...(bridge.pairing && { pairing: bridge.pairing }),
    ...(bridge.me && {
      telegramUserId: bridge.me.id,
      profileName: bridge.me.name,
      username: bridge.me.username,
      number: bridge.me.phone,
    }),
    ...(bridge.lastError && { error: bridge.lastError }),
    stats: { messages: bridge.stats.messages, chats: bridge.stats.chats },
    sync: {
      backfilling: bridge.sync.backfilling,
      pendingBackfill: bridge.sync.pendingBackfill,
      ...(bridge.sync.dialogsSyncedAt && { dialogsSyncedAt: bridge.sync.dialogsSyncedAt }),
      ...(bridge.sync.pausedUntil && { pausedUntil: bridge.sync.pausedUntil }),
    },
  }
}
