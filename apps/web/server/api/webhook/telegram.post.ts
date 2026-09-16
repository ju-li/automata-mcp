import type { AppInstance } from '~~/server/utils/pocketbase'

/**
 * Inbound webhook from a Telegram bridge (apps/telegram-bridge).
 *
 * The bridge posts `{ event: 'connection.update', sessionId, state, ... }` once
 * per state change, to the URL `registerTelegramWebhook()` gave it. This route
 * has the same single job as `evolution.post.ts` — notice that a connection may
 * have changed and hand it to `evaluateConnectionHealth` — under the same rules,
 * restated only where they differ:
 *
 * - **The payload is a hint, never a fact.** Its `state`, `sessionLost` and
 *   `revoked` are not read. The connection is found by its bridge session id and
 *   its live state read from the bridge with that session's own key, so a forged
 *   post costs one rate-limited round-trip and can never produce an email.
 * - **The secret is checked when configured.** The bridge sends it on every
 *   delivery, because it is registered as a custom header.
 * - **Always 200** for a delivery that authenticated, including an unknown
 *   session. The bridge does not retry, so an error status buys nothing but a
 *   line in its log.
 */

/** Per connection, in memory and per worker — see `evolution.post.ts`. */
const COOLDOWN_MS = 30_000
const lastChecked = new Map<string, number>()

export default defineEventHandler(async (event) => {
  const { webhookSecret } = useRuntimeConfig()

  if (webhookSecret) {
    const presented = getRequestHeader(event, 'x-webhook-secret')
    if (presented !== webhookSecret) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid webhook secret' })
    }
  }

  const payload = await readBody<{ event?: string, sessionId?: string }>(event).catch(() => undefined)

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (payload?.event !== 'connection.update' || !sessionId || sessionId.length > 64) return { ok: true }

  const instance = await findInstanceBySession(sessionId)
  // Another deployment's session, a deleted connection, or a forged post.
  if (!instance) return { ok: true }

  const now = Date.now()
  const previous = lastChecked.get(instance.id) ?? 0
  if (now - previous < COOLDOWN_MS) return { ok: true }
  lastChecked.set(instance.id, now)

  try {
    await evaluateConnectionHealth(instance)
  }
  catch (error) {
    // The hourly sweep covers this connection regardless. Logged because a
    // handled error leaves nothing in Nitro's own logs.
    console.error(`[webhook] could not evaluate connection ${instance.id} (${instance.name}):`, error)
  }

  return { ok: true }
})

/**
 * A bridge session id is a UUID the bridge minted, stored as `instance_id`.
 * Kind-filtered so a delivery can never start a health check on a WhatsApp or
 * Postgres row, and bound with `pb.filter()` because the id arrives from the
 * network. The admin client is required: `api_key` is hidden, and it is what the
 * live read authenticates with.
 */
async function findInstanceBySession(sessionId: string): Promise<AppInstance | undefined> {
  try {
    const pb = await pocketbaseAdmin()
    return await firstOrNone<AppInstance>(
      pb,
      'instances',
      pb.filter('instance_id = {:sessionId} && kind = {:kind}', { sessionId, kind: 'telegram' }),
    )
  }
  catch (error) {
    console.error('[webhook] could not resolve the Telegram connection for a delivery:', error)
    return undefined
  }
}
