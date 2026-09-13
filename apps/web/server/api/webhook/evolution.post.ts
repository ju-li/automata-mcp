import type { AppInstance } from '~~/server/utils/pocketbase'

/**
 * Inbound webhook from Evolution API.
 *
 * The URL comes from WEBHOOK_URL / NUXT_WEBHOOK_URL, so dev and prod differ by
 * config only:
 *   dev  http://host.docker.internal:3000/api/webhook/evolution
 *   prod https://<app>/api/webhook/evolution
 *
 * One job: notice that a connection's state may have changed and hand it to
 * `evaluateConnectionHealth`. Nothing else is dispatched — a `MESSAGES_UPSERT`
 * or a `QRCODE_UPDATED` delivery is acked and dropped.
 *
 * **The payload is a hint, never a fact.** Its `state` is not read. Evolution v2
 * does not sign deliveries, the global webhook sends no headers whatsoever, and
 * this route is reachable by anyone who knows the URL — so a payload claiming
 * `close` would otherwise be enough for a stranger to mail a user that their
 * account is down. Instead the connection is looked up by name and its live
 * state read from Evolution with that instance's own credentials. A forged
 * delivery costs one rate-limited round-trip and can never produce an email.
 *
 * The shared-secret check below is real but optional, and the reason is
 * historical: only Evolution's **per-instance** webhook sends custom headers,
 * and until `registerConnectionWebhook()` existed this deployment configured
 * only the global one, so setting NUXT_WEBHOOK_SECRET silently 401'd every
 * delivery — which Evolution treats as non-retryable and drops for good. Now
 * that every connection is registered individually with the header, the secret
 * should be set. If both webhooks are somehow live at once, the global copy
 * fails this check and the per-instance copy carries the event.
 *
 * Always acks 200, including for a secret-less unknown instance: a non-2xx puts
 * Evolution into a ten-attempt retry ladder for a delivery nothing wanted.
 */

/**
 * Per-connection cooldown, so a socket flapping between `connecting` and
 * `close` cannot drive one live Evolution round-trip per event. The state it
 * guards is the read, not the alert — `evaluateConnectionHealth` is idempotent
 * and the grace period is what decides whether anything is sent.
 *
 * In-memory and per-worker on purpose. It protects Evolution from a burst; it
 * is not a security control, and nothing breaks if a restart empties it.
 */
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

  const payload = await readBody<{ event?: string, instance?: string }>(event)

  // Evolution emits the dotted form; the underscored spelling is what its own
  // config flags use, so accept both rather than depend on which one arrives.
  const name = typeof payload?.instance === 'string' ? payload.instance.trim() : ''
  const kind = String(payload?.event ?? '').toLowerCase().replace(/_/g, '.')
  if (kind !== 'connection.update' || !name) return { ok: true }

  const instance = await findInstanceByName(name)
  // Unknown name: another deployment's instance, a deleted connection, or a
  // forged post. Acked and ignored either way.
  if (!instance) return { ok: true }

  const now = Date.now()
  const previous = lastChecked.get(instance.id) ?? 0
  if (now - previous < COOLDOWN_MS) return { ok: true }
  lastChecked.set(instance.id, now)

  try {
    await evaluateConnectionHealth(instance)
  }
  catch (error) {
    // Acked anyway — a retry would arrive into the same failure, and the hourly
    // sweep covers this connection regardless. Logged because a handled error
    // leaves nothing in Nitro's own logs.
    console.error(`[webhook] could not evaluate connection ${instance.id} (${instance.name}):`, error)
  }

  return { ok: true }
})

/**
 * Name is unique on `instances` (`idx_instances_name`), and it is Evolution's
 * own identifier for the account, so it is the only thing a delivery can be
 * matched on.
 *
 * The admin client is required rather than convenient: `api_key` is a hidden
 * field, and without it there is nothing to read Evolution's live state with.
 * The filter is bound with `pb.filter()` — the name arrives from the network and
 * must never be concatenated into a filter string.
 */
async function findInstanceByName(name: string): Promise<AppInstance | undefined> {
  try {
    const pb = await pocketbaseAdmin()
    // Kind-filtered: only a WhatsApp connection has an Evolution instance, so a
    // delivery naming any other row is forged or misrouted and must not trigger
    // a health check against it.
    return await pb.collection('instances').getFirstListItem<AppInstance>(
      pb.filter('name = {:name} && kind = {:kind}', { name, kind: 'whatsapp' }),
    )
  }
  catch (error) {
    if (isPocketBaseNotFound(error)) return undefined
    console.error('[webhook] could not resolve the connection for a delivery:', error)
    return undefined
  }
}
