import { z } from 'zod'

const body = z.object({
  connection: z.string().min(1),
  // Absent = the connection's default for this user, as on the consent page.
  scope: scopeSchema.optional(),
}).and(disclaimerSchema)

/**
 * Add a connection to one of your existing sign-ins, without the app having to
 * send you through authorization again. Widens what a third-party app can
 * reach, so it gets the consent POST's `Origin` check, and the same rules as
 * the consent page (`addConnectionToSession`).
 */
export default defineEventHandler(async (event) => {
  const settings = requireOAuth()
  assertSameOrigin(event, settings)
  const actor = await requireMembership(event)
  const parsed = await parseBody(event, body)
  return await addConnectionToSession(actor, getRouterParam(event, 'id') ?? '', {
    connection: parsed.connection,
    scope: parsed.scope,
    send_disclaimer: parsed.send_disclaimer,
  })
})
