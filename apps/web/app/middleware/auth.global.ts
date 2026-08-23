const PUBLIC_ROUTES = new Set(['/login', '/signup'])

/**
 * Session gate. Authentication only.
 *
 * It deliberately does not look at WhatsApp connection state — that would put an
 * Evolution round-trip on every navigation. `/instances` sends you to
 * `/instances/new` when you have no accounts, and the per-account page decides
 * between showing a QR and showing the dashboard.
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
