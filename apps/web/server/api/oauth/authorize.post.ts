import { z } from 'zod'

const body = z.object({
  params: z.record(z.string(), z.unknown()),
  decision: z.enum(['approve', 'deny']),
  grant: z.string().min(1).optional(),
})

/**
 * The consent decision. Approve binds one of the user's own grants to the
 * client and answers the redirect carrying a single-use code; deny answers the
 * redirect carrying `access_denied`. Either way the browser, not this route,
 * goes there — the page navigates to `redirect`.
 *
 * Nothing here can widen a grant: the user picks one of their own, as an admin
 * made it, and its scope is what the client gets. The request is re-validated
 * from scratch and the grant re-checked under a row lock (`approveAuthorization`).
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
  if (!parsed.grant) {
    throw createError({ statusCode: 422, statusMessage: 'Choose which connector to sign in to.' })
  }
  return { redirect: await approveAuthorization(actor, settings, validated.request, parsed.grant) }
})
