import PocketBase from 'pocketbase'

/**
 * PocketBase is the backend for users, sessions and per-user Evolution
 * credentials. Two distinct clients live here:
 *
 *   `pocketbaseAdmin()`   — a long-lived superuser-authed client. Reads hidden
 *                           fields (`users.evolution_api_key`) and the
 *                           admin-only `mcp_tokens` collection. Never hand this
 *                           to anything that takes user input as a filter.
 *
 *   `pocketbaseForRequest()` — a fresh, unauthenticated client per request, to
 *                           be loaded with the caller's own auth cookie. Its
 *                           auth store must NOT be shared across requests.
 */

let admin: PocketBase | undefined
let adminAuth: Promise<PocketBase> | undefined

function baseUrl(): string {
  const url = useRuntimeConfig().pocketbaseUrl
  if (!url) {
    throw createError({
      statusCode: 500,
      statusMessage: 'NUXT_POCKETBASE_URL is not set',
    })
  }
  return url
}

/** A new client with an empty auth store. One per request. */
export function pocketbaseForRequest(): PocketBase {
  const pb = new PocketBase(baseUrl())
  // Server-side there is no "user navigated away" — auto-cancellation would
  // abort concurrent requests that happen to share a key.
  pb.autoCancellation(false)
  return pb
}

/**
 * Superuser-authenticated client, memoized. Re-authenticates when the token
 * expires. Concurrent callers share one in-flight auth request.
 */
export function pocketbaseAdmin(): Promise<PocketBase> {
  if (!admin) {
    admin = new PocketBase(baseUrl())
    admin.autoCancellation(false)
  }

  if (admin.authStore.isValid) {
    return Promise.resolve(admin)
  }

  if (!adminAuth) {
    const config = useRuntimeConfig()
    const { pocketbaseAdminEmail: email, pocketbaseAdminPassword: password } = config

    if (!email || !password) {
      return Promise.reject(createError({
        statusCode: 500,
        statusMessage: 'NUXT_POCKETBASE_ADMIN_EMAIL / NUXT_POCKETBASE_ADMIN_PASSWORD are not set',
      }))
    }

    const pb = admin
    adminAuth = pb
      .collection('_superusers')
      .authWithPassword(email, password)
      .then(() => pb)
      .catch((cause) => {
        // PocketBase unreachable or the superuser credentials are wrong. Callers
        // must not translate this into "your credential is bad" — see the 404
        // handling in server/utils/mcp-auth.ts.
        throw createError({
          statusCode: 503,
          statusMessage: 'Auth backend unavailable',
          cause,
        })
      })
      .finally(() => {
        adminAuth = undefined
      })
  }

  return adminAuth
}

/** Shape of the fields this app adds to the built-in `users` collection. */
export interface AppUser {
  id: string
  email: string
  evolution_url?: string
  evolution_api_key?: string
}
