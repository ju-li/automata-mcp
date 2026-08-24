import type { H3Event } from 'h3'
import type { AppUser } from './pocketbase'

/**
 * Auth for the browser UI — and ONLY the browser UI.
 *
 * PocketBase issues an auth cookie; this reads it, validates it against
 * PocketBase, and puts the user on `event.context.user`.
 *
 * Nothing here is reachable from the MCP surface: server/middleware/session.ts
 * returns early on /mcp before this ever runs, and MCP tools read
 * `event.context.mcpAuth` instead. Keep it that way — a shared "get current
 * user" helper across both surfaces is exactly the bug this split prevents.
 */

export const PB_COOKIE = 'pb_auth'

export async function getSessionUser(event: H3Event): Promise<AppUser | undefined> {
  const cookie = getRequestHeader(event, 'cookie')
  if (!cookie || !cookie.includes(`${PB_COOKIE}=`)) return undefined

  // A per-request client — the admin client's auth store must never be
  // overwritten with a visitor's token.
  const pb = pocketbaseForRequest()
  pb.authStore.loadFromCookie(cookie, PB_COOKIE)

  if (!pb.authStore.isValid) return undefined

  try {
    const { record } = await pb.collection('users').authRefresh<AppUser>()
    // Note: `evolution_api_key` is a hidden field and is NOT present here. Use
    // the admin client when you need it server-side.
    return record
  } catch (error) {
    const status = (error as { status?: number })?.status

    // The cookie really is no longer good: expired, revoked, user deleted.
    if (status === 401 || status === 403 || status === 404) return undefined

    // Anything else — PocketBase unreachable, 500, timeout — is our problem,
    // not the visitor's. Returning undefined here would answer 401, which the
    // client reads as "signed out": during an outage every signed-in user gets
    // silently bounced to /login instead of being told the backend is down.
    // Same distinction resolveMcpAuth makes for tokens; keep both surfaces
    // honest about the difference.
    console.error(`[pocketbase] could not validate a session against ${useRuntimeConfig().pocketbaseUrl}`, error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Auth backend unavailable',
      cause: error,
    })
  }
}

/** Throws 401 instead of returning undefined. For UI API routes. */
export async function requireSessionUser(event: H3Event): Promise<AppUser> {
  const user = event.context.user as AppUser | undefined ?? await getSessionUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not signed in' })
  }
  return user
}
