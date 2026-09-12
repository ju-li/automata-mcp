/**
 * Revoke a token.
 *
 * Either an organization admin or the member the token was issued to: destroying
 * your own credential must never need someone else's approval, and a member who
 * cannot revoke is a member who cannot respond to a leak. A token id outside the
 * actor's organization, or another member's, resolves to 404 rather than 403, so
 * this cannot be used to probe which ids exist.
 */
export default defineEventHandler(async (event) => {
  const { token } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  await revokeToken(token)
  return { ok: true }
})
