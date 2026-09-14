/**
 * Hourly connection sweep — the complete half of disconnect alerting, for
 * WhatsApp and Telegram connections.
 *
 * The webhook is faster but structurally incomplete: in Evolution 2.3.7 a close
 * it intends to retry emits no `connection.update` at all, so the socket that
 * dies and never comes back is the one case a webhook can never report. A
 * Telegram bridge that is down cannot deliver anything either. Only a live read
 * finds those, and this is what performs one.
 *
 * Runs in-process, so a deployment with more than one replica would run one
 * sweep per replica and mail twice. Keep this service at a single instance, or
 * give the sweep a lock before scaling it.
 */
export default defineTask({
  meta: {
    name: 'alerts:sweep',
    description: 'Check every WhatsApp and Telegram connection and notify the people who use it of a change',
  },
  async run() {
    const result = await sweepConnectionAlerts()
    console.info(`[alerts] swept ${result.checked} connection(s), ${result.failed} failed`)
    return { result }
  },
})
