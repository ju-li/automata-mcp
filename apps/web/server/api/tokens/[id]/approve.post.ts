import { z } from 'zod'

const body = scopeSchema.and(disclaimerSchema).and(z.object({
  label: z.string().trim().min(1, 'Give the token a name').max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
}))

/**
 * Approve a member's token request, with the scope the manager settles on.
 *
 * Manager-only (an admin, or the member who created the connection) — the same
 * people who mint, for the same reason: what a token reaches is theirs to
 * decide. The response carries no secret. The holder collects one from the
 * token's row, which is the only place a usable plaintext for it ever appears.
 *
 * No plan-limit check here: the request already took its slot when it was
 * filed, and checking again would refuse the approval of a request the
 * organization was allowed to make.
 */
export default defineEventHandler(async (event) => {
  const { token, instance, actor, can } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  if (can !== 'manage') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only an organization admin or the member who created this connection can approve a token request.',
    })
  }

  return {
    record: await approveTokenRequest(actor, instance, token, {
      label: parsed.label,
      preset: parsed.expiry,
      scope: scopeFromInput(parsed),
      sendDisclaimer: parsed.send_disclaimer,
    }),
  }
})
