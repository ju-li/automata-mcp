/**
 * What the consent page shows for one authorization request: the client (by
 * the name it chose, plus the host it will send the browser back to), and every
 * connection the signed-in user reaches with what they may grant it.
 *
 * Session-authenticated: this is the web surface, the one place in the OAuth
 * flow a cookie is read. Validation runs here and again on approval and on
 * exchange, so the page is never trusted to have kept what it was shown.
 *
 * A request too broken to redirect (unknown client, unregistered redirect URI)
 * is a 400 the page shows. One that is merely wrong comes back as
 * `errorRedirect`, which the page follows — RFC 6749 §4.1.2.1.
 */
export default defineEventHandler(async (event) => {
  const settings = requireOAuth()
  const actor = await requireMembership(event)
  const validated = await validateAuthorizationRequest(settings, authorizationParams(getQuery(event)))
  if ('errorRedirect' in validated) return { errorRedirect: validated.errorRedirect }

  const { request } = validated
  const isAdmin = actor.role === 'admin'
  const members = isAdmin ? [] : await listOrgMembers(actor.org.id)

  return {
    client: {
      name: request.client.name,
      redirectHost: new URL(request.redirectUri).host,
    },
    user: { email: actor.user.email },
    org: { name: actor.org.name },
    isAdmin,
    options: await listConsentOptions(actor),
    // For a member who finds a connection not enabled for sign-in: who to ask.
    admins: members.filter(m => m.role === 'admin').map(m => m.email),
  }
})
