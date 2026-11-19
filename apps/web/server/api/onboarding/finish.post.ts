/**
 * Finish (or skip) first-run setup. Only ever clears setup that is this
 * user's own; anyone else gets 204 and nothing changes. See
 * server/utils/onboarding.ts.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireMembership(event)
  await finishOnboarding(actor)
  setResponseStatus(event, 204)
  return null
})
