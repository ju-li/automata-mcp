/**
 * Hourly: recompute stale inbound-silence baselines (#238) — each WhatsApp
 * account's gaps between received messages over four weeks, by band. See
 * server/utils/whatsapp-silence.ts.
 *
 * Safe on several replicas: each baseline is leased before it is computed.
 */
export default defineTask({
  meta: {
    name: 'whatsapp:silence-baselines',
    description: 'Recompute WhatsApp accounts\' inbound-silence baselines',
  },
  async run() {
    const result = await refreshSilenceBaselines()
    if (result.computed || result.failed) {
      console.info(`[silence] ${result.computed} baseline(s) computed, ${result.failed} failed`)
    }
    return { result }
  },
})
