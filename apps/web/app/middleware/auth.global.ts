const PUBLIC_ROUTES = new Set(['/login', '/signup'])

/** Reachable while signed in but belonging to no organization. */
const ORGLESS_ROUTE = '/no-organization'

/**
 * Your own account, reachable with or without an organization: changing a
 * password or adding a second factor must not wait on someone inviting you.
 */
const PROFILE_ROUTE = '/profile'

/** An invitation link is reachable signed out, signed in, and with no organization. */
function isInviteRoute(path: string): boolean {
  return path.startsWith('/invite/')
}

/**
 * Confirming an email address, the same: a signup is signed out until the code
 * comes back, an address change is signed in, and the mailed link may be opened
 * in any browser at all.
 */
const VERIFY_ROUTE = '/verify-email'

/**
 * Resetting a forgotten password, the same: asked for signed out, and the
 * mailed link may be opened in any browser — one signed in to another account
 * included, which a reset leaves signed in.
 */
const RESET_ROUTES = new Set(['/forgot-password', '/reset-password'])

/** First-run setup; see pages/welcome.vue. */
const WELCOME_ROUTE = '/welcome'

/**
 * Session gate. Authentication, plus the two routing decisions that depend on
 * the organization.
 *
 * It deliberately does not look at a connection's live state — that would put an
 * Evolution round-trip, or a database connection, on every navigation.
 * `/instances` sends you to `/instances/new` when you have none, and the
 * per-connection page picks its panel from the connection's kind.
 *
 * The organization checks cost nothing extra: the role arrives on the same
 * `/api/auth/me` response the session already needs.
 *
 * **An invitation link escapes every redirect below.** Someone who has just been
 * removed from an organization, or who has never had one, must be able to open
 * one and accept it — bouncing them to the dead-end page would make the
 * invitation unusable by exactly the people it is for. It is also the one place
 * a signed-in user is not pushed off a public route, because accepting is what
 * they came to do.
 *
 * Role-based redirects, here and in the pages, are **convenience only**. Every
 * one of them is independently enforced server-side; unhiding a control in the
 * browser gets you a 403, not an action.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { user, hasOrg, isAdmin, canCreateConnections, membership, onboarding, ensureLoaded } = useSession()
  await ensureLoaded()

  if (isInviteRoute(to.path) || to.path === VERIFY_ROUTE || RESET_ROUTES.has(to.path)) return

  const isPublic = PUBLIC_ROUTES.has(to.path)

  if (!user.value && !isPublic) {
    return navigateTo('/login')
  }

  if (user.value && isPublic) {
    return navigateTo('/instances')
  }

  if (!user.value) return

  if (!hasOrg.value && to.path !== ORGLESS_ROUTE && to.path !== PROFILE_ROUTE) {
    return navigateTo(ORGLESS_ROUTE)
  }

  if (hasOrg.value && to.path === ORGLESS_ROUTE) {
    return navigateTo('/instances')
  }

  // First-run setup: the admin whose signup made the organization lands in it
  // instead of the bare create page, until they finish or skip it. Only the
  // landing routes redirect — Billing (hosted checkout returns there), Profile
  // and the rest stay reachable mid-setup.
  if (onboarding.value && (to.path === '/instances' || to.path === '/instances/new')) {
    return navigateTo('/welcome')
  }
  // Picking a connector clears the flag, so a run in progress is let through by
  // `welcome:active` (this page load only). Anyone else — back after walking
  // away mid-way — gets the ordinary screen: the connection's own page, where
  // pairing and tokens live, or the list.
  if (!onboarding.value && to.path === WELCOME_ROUTE && !useState<boolean>('welcome:active', () => false).value) {
    const connection = typeof to.query.connection === 'string' ? to.query.connection : undefined
    return navigateTo(connection ? `/instances/${encodeURIComponent(connection)}` : '/instances')
  }

  // An organization that lets only admins add connections makes the create flow
  // a dead end for its members.
  if (!canCreateConnections.value && to.path === '/instances/new') {
    return navigateTo('/instances')
  }

  // Billing is an admin's page, and exists only where plans do: a deployment
  // without billing reports no plan, and has no such page to show.
  if (to.path === '/billing' && (!isAdmin.value || !membership.value?.org.plan)) {
    return navigateTo('/instances')
  }
})
