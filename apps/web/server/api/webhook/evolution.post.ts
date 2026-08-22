/**
 * Inbound webhook from Evolution API.
 *
 * The URL comes from WEBHOOK_URL / NUXT_WEBHOOK_URL, so dev and prod differ by
 * config only:
 *   dev  http://host.docker.internal:3000/api/webhook/evolution
 *   prod https://<app>/api/webhook/evolution
 *
 * Stub. Evolution v2 does not sign webhook payloads, so this checks a shared
 * secret header that you attach when registering per-instance webhooks. Event
 * handling is yours to build.
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
