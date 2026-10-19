/** The address change waiting on verification, if any, for the profile page. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  return { pendingEmail: (await pendingEmailChange(user.id)) ?? null }
})
