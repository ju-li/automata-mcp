/**
 * Sign one of your own sign-ins out: the app stops working on every connection
 * it covered, as if it had revoked its tokens itself. Someone else's sign-in is
 * a 404 — it does not exist for you.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  await endOwnSession(user.id, getRouterParam(event, 'id') ?? '')
  return { ok: true }
})
