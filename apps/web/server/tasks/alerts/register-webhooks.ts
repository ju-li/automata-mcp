/**
 * Hourly webhook re-registration for every WhatsApp and Telegram connection.
 *
 * Kept apart from `alerts:sweep` so the sweep can run every five minutes without
 * a registration call per connection each time. See
 * `reregisterConnectionWebhooks` for why registration is re-asserted at all.
 */
export default defineTask({
  meta: {
    name: 'alerts:register-webhooks',
    description: 'Re-register the connection webhook of every WhatsApp and Telegram connection',
  },
  async run() {
    const result = await reregisterConnectionWebhooks()
    console.info(`[alerts] re-registered webhooks for ${result.registered} connection(s)`)
    return { result }
  },
})
