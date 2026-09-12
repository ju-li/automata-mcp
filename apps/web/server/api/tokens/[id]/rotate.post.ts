/**
 * Issue a new secret for a token, keeping its scope.
 *
 * Either an organization admin or the member the token was issued to. A member
 * rotating their own credential needs no approval — a leaked key must be
 * replaceable the moment it is noticed, and waiting on an admin is how a leak
 * stays live over a weekend. What a member still cannot do is change what the
 * token reaches: that is `PATCH`, and it is admin-only.
 *
 * The old secret stops working immediately, and the new plaintext is in this
 * response and nowhere else.
 */
export default defineEventHandler(async (event) => {
  const { token } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  return await rotateToken(token)
})
