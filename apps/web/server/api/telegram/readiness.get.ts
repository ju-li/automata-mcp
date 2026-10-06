/**
 * Whether a Telegram connection can be created on this deployment's own bridge.
 *
 * The create page asks before an admin fills in the form, so a deployment
 * running without Telegram's API credentials says what to set rather than
 * failing on the click. Admin-only, like creating a connection: it reports on
 * the deployment's configuration and nothing a member can act on.
 */
export default defineEventHandler(async (event) => {
  await requireOrgAdmin(event)
  return { deploymentBridge: await deploymentBridgeReadiness() }
})
