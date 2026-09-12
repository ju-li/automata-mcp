const PUBLIC_ROUTES = new Set(['/login', '/signup'])

/** Reachable while signed in but belonging to no organization. */
const ORGLESS_ROUTE = '/no-organization'

/**
 * Session gate. Authentication, plus the one routing decision that depends on
 * having an organization at all.
 *
 * It deliberately does not look at a connection's live state — that would put an
 * Evolution round-trip, or a database connection, on every navigation.
 * `/instances` sends you to `/instances/new` when you have none, and the
 * per-connection page picks its panel from the connection's kind.
 *
 * The organization check costs nothing extra: the role arrives on the same
 * `/api/auth/me` response the session already needs. Belonging to no
 * organization is a dead end rather than an error — every API route would answer
 * 403 — so it gets a page that says what happened instead of a broken listing.
 *
 * Role-based redirects, here and in the pages, are **convenience only**. Every
 * one of them is independently enforced server-side; unhiding a control in the
 * browser gets you a 403, not an action.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { user, hasOrg, ensureLoaded } = useSession()
  await ensureLoaded()

  const isPublic = PUBLIC_ROUTES.has(to.path)

  if (!user.value && !isPublic) {
    return navigateTo('/login')
  }

  if (user.value && isPublic) {
    return navigateTo('/instances')
  }

  if (!user.value) return

  if (!hasOrg.value && to.path !== ORGLESS_ROUTE) {
    return navigateTo(ORGLESS_ROUTE)
  }

  if (hasOrg.value && to.path === ORGLESS_ROUTE) {
    return navigateTo('/instances')
  }
})
