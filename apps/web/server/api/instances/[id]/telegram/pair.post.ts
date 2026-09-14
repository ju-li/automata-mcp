/**
 * Start linking a Telegram account by QR code.
 *
 * Explicit, never on page load: pairing binds a real account, so it starts only
 * when an admin asks. Idempotent while a flow is already running; the bridge
 * abandons a flow nobody completes within five minutes.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const bridge = telegramBridgeForInstance(instance)
  try {
    return pairingView(await bridge.pair())
  }
  catch (error) {
    relayBridgeError(error, 'start pairing')
  }
})
