/**
 * What the consent page shows for one authorization request: the client (by
 * the name it chose, plus the host it will send the browser back to), and the
 * signed-in user's own grants it could be given.
 *
 * Session-authenticated: this is the web surface, the one place in the OAuth
 * flow a cookie is read. Validation runs here and again on approval, so the
 * page is never trusted to have kept what it was shown.
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
  const grants = await listClaimableGrants(actor)
  const isAdmin = actor.role === 'admin'

  const members = await listOrgMembers(actor.org.id)
  const connections = isAdmin
    ? (await listOrgInstances(actor.org.id))
        .filter(isSupportedInstance)
        .map(instance => toPublicInstance(instance))
        .map(instance => ({ id: instance.id, label: instance.label, kind: instance.kind }))
    : []

  return {
    client: {
      name: request.client.name,
      redirectHost: new URL(request.redirectUri).host,
    },
    user: { email: actor.user.email },
    org: { name: actor.org.name },
    isAdmin,
    grants,
    // For an admin, the connections the "create one now" shortcut can use.
    connections,
    // For a member with nothing to approve: who to ask.
    admins: isAdmin ? [] : members.filter(m => m.role === 'admin').map(m => m.email),
  }
})
