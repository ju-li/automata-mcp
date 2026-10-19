/** Drop the pending address change; the code and link mailed for it stop working. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  await cancelEmailChange(event, user.id)
  return { ok: true }
})
