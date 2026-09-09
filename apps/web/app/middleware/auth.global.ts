const PUBLIC_ROUTES = new Set(['/login', '/signup'])

/**
 * Session gate. Authentication only.
 *
 * It deliberately does not look at a connection's live state — that would put an
 * Evolution round-trip, or a database connection, on every navigation.
 * `/instances` sends you to `/instances/new` when you have none, and the
 * per-connection page picks its panel from the connection's kind.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { user, ensureLoaded } = useSession()
  await ensureLoaded()

  const isPublic = PUBLIC_ROUTES.has(to.path)

  if (!user.value && !isPublic) {
    return navigateTo('/login')
  }

  if (user.value && isPublic) {
    return navigateTo('/instances')
  }
})
