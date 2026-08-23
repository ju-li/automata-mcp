/**
 * Revoke a token. Scoped to the caller: another account's token id resolves to
 * 404, so this cannot be used to probe which ids exist or to revoke someone
 * else's connector.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const id = getRouterParam(event, 'id')

  if (!id || !await revokeToken(user.id, id)) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  return { ok: true }
})
