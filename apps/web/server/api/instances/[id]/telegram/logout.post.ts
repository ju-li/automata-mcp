/**
 * Unlink the Telegram account: logged out on Telegram's side, and every chat
 * synced for it deleted. The connection and its tokens stay, ready to be linked
 * again — to the same account or another one.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const bridge = telegramBridgeForInstance(instance)
  try {
    return pairingView(await bridge.logout())
  }
  catch (error) {
    relayBridgeError(error, 'log out')
  }
})
