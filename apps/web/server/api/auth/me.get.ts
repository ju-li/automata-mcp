import type { AppUser } from '~~/server/utils/pocketbase'

/**
 * Current session, or `{ user: null }`. Deliberately not a 401: the client
 * middleware calls this on every navigation to decide where to send the user,
 * and an error response would make "signed out" indistinguishable from "the
 * request failed".
 */
export default defineEventHandler((event) => {
  const user = event.context.user as AppUser | undefined
  if (!user) return { user: null }
  return { user: { id: user.id, email: user.email, name: user.name } }
})
