/**
 * Hourly connection sweep — the complete half of disconnect alerting.
 *
 * The webhook is faster but structurally incomplete: in Evolution 2.3.7 a close
 * it intends to retry emits no `connection.update` at all, so the socket that
 * dies and never comes back is the one case a webhook can never report. Only a
 * live read finds it, and this is what performs one.
 *
 * Runs in-process, so a deployment with more than one replica would run one
 * sweep per replica and mail twice. Keep this service at a single instance, or
 * give the sweep a lock before scaling it.
 */
export default defineTask({
  meta: {
    name: 'alerts:sweep',
    description: 'Check every WhatsApp connection and notify owners of a change',
  },
  async run() {
    const result = await sweepConnectionAlerts()
    console.info(`[alerts] swept ${result.checked} connection(s), ${result.failed} failed`)
    return { result }
  },
})
