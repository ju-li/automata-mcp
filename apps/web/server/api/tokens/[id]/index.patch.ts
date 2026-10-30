import { z } from 'zod'

const body = scopeSchema.and(disclaimerSchema).and(z.object({
  /**
   * Absent leaves the name as it is, so a PATCH from a client that only edits
   * scope cannot clear it. Present must be non-empty: unlike minting there is
   * nothing to fall back to, and "Untitled token" is not a name anyone chose.
   */
  label: z.string().trim().min(1, 'Give the token a name').max(100).optional(),
}))

/**
 * Change a token's scope in place, its name when the body names one, and its
 * send disclaimer when the body names one (`null` turns it off).
 *
 * Deliberately does not reissue: the connector already configured in Claude
 * keeps working, and only what it may reach changes. Scope is read fresh on
 * every MCP request, so the change takes effect on the next call. The name is
 * not part of the credential either, so renaming costs nothing on the wire.
 *
 * Admin-only, and that is the point of the whole permission split: what a token
 * may reach is an organization decision. A member holding the token may destroy
 * it or rotate its secret, and may not widen it. A token id outside the actor's
 * organization — or another member's token — resolves to 404 rather than 403, so
 * this cannot be used to probe which ids exist.
 */
export default defineEventHandler(async (event) => {
  const { token, can } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  if (can !== 'manage') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only an organization admin can change what a token may reach.',
    })
  }

  return {
    record: await updateTokenScope(token, scopeFromInput(parsed), parsed.send_disclaimer, parsed.label),
  }
})
