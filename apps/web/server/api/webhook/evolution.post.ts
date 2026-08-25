/**
 * Inbound webhook from Evolution API.
 *
 * The URL comes from WEBHOOK_URL / NUXT_WEBHOOK_URL, so dev and prod differ by
 * config only:
 *   dev  http://host.docker.internal:3000/api/webhook/evolution
 *   prod https://<app>/api/webhook/evolution
 *
 * Stub. Evolution v2 does not sign webhook payloads, so this checks a shared
 * secret header. Event handling is yours to build.
 *
 * Two things about that secret, both load-bearing:
 *
 * - Only Evolution's **per-instance** webhook sends custom headers. The global
 *   webhook — which is what we configure, via WEBHOOK_GLOBAL_URL — sends none, so
 *   setting NUXT_WEBHOOK_SECRET today makes every delivery fail this check.
 * - Evolution treats 401 as non-retryable (alongside 400/403/404/422), so a
 *   rejected delivery is dropped for good rather than retried. Leaving the secret
 *   unset leaves this route unauthenticated; setting it silently discards
 *   everything. Register per-instance webhooks with the header before you set it.
 *
 * Delivery is also gated upstream: Evolution only sends an event whose
 * WEBHOOK_EVENTS_<EVENT> flag is true, each of which defaults to false. See the
 * evolution service in docker-compose.dev.yml.
 */
export default defineEventHandler(async (event) => {
  const { webhookSecret } = useRuntimeConfig()

  if (webhookSecret) {
    const presented = getRequestHeader(event, 'x-webhook-secret')
    if (presented !== webhookSecret) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid webhook secret' })
    }
  }

  const payload = await readBody<{ event?: string, instance?: string }>(event)

  // TODO: dispatch on payload.event (messages.upsert, connection.update,
  // qrcode.updated, ...). Ack fast — Evolution retries on non-2xx.
  console.info('[webhook] evolution', payload?.event, payload?.instance)

  return { ok: true }
})
