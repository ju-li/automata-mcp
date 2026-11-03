import { z } from 'zod'

const selection = z.object({
  connection: z.string().min(1),
  // Optional: absent means the connection's default for this user. When given,
  // the same schema as minting, so an empty allowlist is refused by name.
  scope: scopeSchema.optional(),
}).and(disclaimerSchema)

const body = z.object({
  params: z.record(z.string(), z.unknown()),
  decision: z.enum(['approve', 'deny']),
  selections: z.array(selection).max(50).default([]),
})

/**
 * The consent decision. Approve checks what was picked against what the user
 * may grant now (`validateSelections` — reach, and for a member the
 * connection's ceiling) and answers the redirect carrying a single-use code;
 * deny answers the redirect carrying `access_denied`. Either way the browser,
 * not this route, goes there — the page navigates to `redirect`.
 */
export default defineEventHandler(async (event) => {
  const settings = requireOAuth()
  assertSameOrigin(event, settings)
  const actor = await requireMembership(event)
  const parsed = await parseBody(event, body)

  const validated = await validateAuthorizationRequest(settings, authorizationParams(parsed.params))
  if ('errorRedirect' in validated) return { redirect: validated.errorRedirect }

  if (parsed.decision === 'deny') {
    return { redirect: denyAuthorization(settings, validated.request) }
  }
  return { redirect: await approveAuthorization(actor, settings, validated.request, parsed.selections) }
})
