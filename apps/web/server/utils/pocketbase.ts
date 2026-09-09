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
        // The response stays deliberately vague — an unauthenticated caller
        // should not learn whether our backend is down or misconfigured. But it
        // has to be logged, and loudly: this throws a *handled* error, so Nitro
        // does not log it at all, and the operator would otherwise see a 503
        // with nothing whatsoever in the server logs to explain it.
        //
        // The two causes need different fixes, so name which one it is.
        const status = (cause as { status?: number })?.status
        const detail = status === 400
          ? `PocketBase rejected the superuser credentials. Check NUXT_POCKETBASE_ADMIN_EMAIL / NUXT_POCKETBASE_ADMIN_PASSWORD, and that the account exists: pocketbase superuser upsert <email> <password> --dir=/pb_data`
          : `Could not reach PocketBase at ${baseUrl()}. Check NUXT_POCKETBASE_URL, including its port — a service that follows $PORT may not be on the port you expect.`

        console.error(`[pocketbase] superuser auth failed. ${detail}`, cause)

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

/**
 * PocketBase answers 404 when a record genuinely does not exist. Every other
 * failure — unreachable, 500, network — means the backend is broken, not that
 * the caller asked for something absent. Callers must keep those apart: see the
 * 503 handling in mcp-auth.ts for why.
 */
export function isPocketBaseNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 404
}

/**
 * Shapes of our PocketBase records. Kept here so both `evolution.ts` and
 * `instances.ts` can refer to them without importing each other.
 */

export interface AppUser {
  id: string
  email: string
  name?: string
}

/**
 * One connection. `kind` says what sort — the row's other fields are read
 * according to it, and it decides which MCP tools a token on this row can see.
 *
 * Optional in the type, and absent on any row written before `kind` existed.
 * Read it through `instanceKind()` in mcp-scope.ts rather than directly, so
 * "absent means WhatsApp" is decided in exactly one place.
 *
 * Three fields are `hidden` PocketBase fields — `api_key`, `admin_key`, `dsn` —
 * so they are only ever populated on records fetched through `pocketbaseAdmin()`.
 * A record from a session-scoped client will have them undefined.
 *
 * `api_key` is Evolution's per-instance token. `admin_key` is a *global* key for
 * a user-supplied Evolution server and can create and delete instances on it, so
 * it is a wider secret than anything else on the row: never let it reach
 * `credentialsForInstance()`. `dsn` is a user-supplied Postgres connection
 * string. `hidden` keeps all three out of the REST projection; it is not
 * encryption, and they sit in clear in `pb_data`.
 */
export interface AppInstance {
  id: string
  user: string
  kind?: 'whatsapp' | 'postgres'
  name: string
  instance_id?: string
  api_key?: string
  admin_key?: string
  base_url?: string
  dsn?: string
  pg_host?: string
  pg_port?: number
  pg_database?: string
  label?: string
  created?: string
}

export interface AppMcpToken {
  id: string
  user: string
  instance: string
  token_hash: string
  label?: string
  last_used_at?: string
  expires_at?: string
  revoked?: boolean
  created?: string
  // Scope. See server/utils/mcp-scope.ts — PocketBase materialises an unset
  // boolean as `false`, so these must always be written explicitly.
  all_chats?: boolean
  chat_jids?: unknown
  all_tools?: boolean
  tool_names?: unknown
}
