/**
 * Whether a Telegram connection can be created on this deployment's own bridge.
 *
 * The create page asks before anyone fills in the form, so a deployment running
 * without Telegram's API credentials says what to set rather than failing on
 * the click. Any member, like creating a connection: it answers one word about
 * the deployment's own bridge and nothing about anyone's connections.
 */
export default defineEventHandler(async (event) => {
  await requireMembership(event)
  return { deploymentBridge: await deploymentBridgeReadiness() }
})
