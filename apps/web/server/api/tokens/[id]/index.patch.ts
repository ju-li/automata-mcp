/**
 * Change a token's scope in place.
 *
 * Deliberately does not reissue: the connector already configured in Claude
 * keeps working, and only what it may reach changes. Scope is read fresh on
 * every MCP request, so the change takes effect on the next call.
 *
 * Admin-only, and that is the point of the whole permission split: what a token
 * may reach is an organization decision. A member holding the token may destroy
 * it or rotate its secret, and may not widen it. A token id outside the actor's
 * organization — or another member's token — resolves to 404 rather than 403, so
 * this cannot be used to probe which ids exist.
 */
export default defineEventHandler(async (event) => {
  const { token, can } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, scopeSchema)

  if (can !== 'manage') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only an organization admin can change what a token may reach.',
    })
  }

  return { record: await updateTokenScope(token, scopeFromInput(parsed)) }
})
