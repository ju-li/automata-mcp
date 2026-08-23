/**
 * Change a token's scope in place.
 *
 * Deliberately does not reissue: the connector already configured in Claude
 * keeps working, and only what it may reach changes. Scope is read fresh on
 * every MCP request, so the change takes effect on the next call.
 *
 * Scoped to the caller — another account's token id resolves to 404, matching
 * revoke, so this cannot be used to probe for or retune someone else's token.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const id = getRouterParam(event, 'id')
  const parsed = await parseBody(event, scopeSchema)

  if (!id) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const record = await updateTokenScope(user.id, id, scopeFromInput(parsed))
  if (!record) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  return { record }
})
