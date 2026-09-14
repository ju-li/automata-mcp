/**
 * Bring a dropped Telegram connection back from its stored session. Answers at
 * once; the connection comes up in the background and shows in the status.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const bridge = telegramBridgeForInstance(instance)
  try {
    return pairingView(await bridge.reconnect())
  }
  catch (error) {
    relayBridgeError(error, 'reconnect')
  }
})
