/**
 * The current pairing QR code, and where pairing has got to.
 *
 * Safe to poll, unlike WhatsApp's: the bridge only reads the code of a flow that
 * `pair` already started and never asks Telegram for a new login token on its
 * own, so a poll cannot turn into a stream of login attempts.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const bridge = telegramBridgeForInstance(instance)
  try {
    const { state, qr } = await bridge.qr()
    return pairingView(state, qr)
  }
  catch (error) {
    relayBridgeError(error, 'read the pairing QR code')
  }
})
