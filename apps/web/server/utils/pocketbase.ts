import PocketBase from 'pocketbase'

/**
 * PocketBase is the backend for users, sessions, connections and the credentials
 * those connections carry. Two distinct clients live here:
 *
 *   `pocketbaseAdmin()`   — a long-lived superuser-authed client. Reads the
 *                           hidden fields on `instances` (`api_key`,
 *                           `admin_key`, `dsn`) and the admin-only `mcp_tokens`
 *                           collection. Never hand this to anything that takes
 *                           user input as a filter.
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
 * expires, and when PocketBase rejects one that has not — see
 * `createAdminClient`. Concurrent callers share one in-flight auth request.
 */
export function pocketbaseAdmin(): Promise<PocketBase> {
  if (!admin) admin = createAdminClient()

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
 * The admin client, wrapped so a token PocketBase has stopped accepting is
 * replaced rather than presented until it expires.
 *
 * `authStore.isValid` only reads the token's own expiry claim; it cannot know
 * the server has revoked it. And the server does revoke it: `entrypoint.sh`
 * runs `superuser upsert` on every boot, which rotates the account's token key.
 * Before this, one PocketBase restart left every admin call answering 403 for
 * the rest of the token's life — every MCP request a 503 even with a good
 * connector token, every dashboard a raw 403 — with nothing in the logs,
 * because the re-authentication path that logs was never reached.
 *
 * So a 401 or 403 reads as "this credential is dead", which is safe for this
 * client alone: a superuser bypasses every API rule, so it is never refused for
 * lack of permission, only for presenting a token PocketBase no longer honours.
 * The request is retried exactly once, and a second refusal is rethrown as real.
 *
 * Retrying the caller's original `options` is sound because the SDK's `send`
 * works on a shallow copy and writes `Authorization` into a fresh `headers`
 * object, so the retry carries the new token rather than the rejected one.
 */
function createAdminClient(): PocketBase {
  const pb = new PocketBase(baseUrl())
  // Server-side there is no "user navigated away" — auto-cancellation would
  // abort concurrent requests that happen to share a key.
  pb.autoCancellation(false)

  const send = pb.send.bind(pb)

  pb.send = async <T = any>(path: string, options: Parameters<PocketBase['send']>[1]): Promise<T> => {
    // Read before sending: the SDK takes the token synchronously as `send`
    // starts, so this is the token the server is about to judge.
    const presented = pb.authStore.token

    try {
      return await send<T>(path, options)
    }
    catch (error) {
      // Never for the superuser auth call itself, which would wait on its own
      // in-flight promise and never settle.
      if (!isRejectedCredential(error) || path.startsWith(SUPERUSER_AUTH_PATH)) throw error

      // Clear only the token that was refused. Concurrent requests all fail on
      // the same dead token: the first clears it and re-authenticates, and a
      // straggler arriving afterwards must not throw away the fresh one.
      if (pb.authStore.token === presented) {
        console.warn(
          `[pocketbase] superuser token rejected (${httpStatusOf(error)}); re-authenticating and retrying once. `
          + 'Expected after a PocketBase restart, which rotates the superuser token key.',
        )
        pb.authStore.clear()
      }

      // Resolves at once if another request already re-authenticated; joins the
      // shared in-flight request otherwise. A failure here is the 503 it should be.
      await pocketbaseAdmin()
      return await send<T>(path, options)
    }
  }

  return pb
}

const SUPERUSER_AUTH_PATH = '/api/collections/_superusers/auth-'

function isRejectedCredential(error: unknown): boolean {
  const status = httpStatusOf(error)
  return status === 401 || status === 403
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
 * First row of a filtered read, or `undefined` — WITHOUT conflating "no row"
 * with "no collection".
 *
 * `getFirstListItem` throws 404 for an empty result, and PocketBase answers 404
 * for a collection that does not exist as well. `isPocketBaseNotFound` cannot
 * tell them apart, so a read written with `getFirstListItem` treats a schema
 * that has not been migrated yet as "this row is absent". Nuxt and PocketBase
 * deploy as separate services with nothing ordering them, so that window is
 * real, and on the MCP side it would answer **401** — telling every connected
 * client that its perfectly good token had been revoked, and inviting it to
 * throw the token away. That is the exact outcome the 401-vs-503 rule exists to
 * prevent.
 *
 * `getList` makes an empty result a value and leaves a throw meaning a fault.
 * Use this for every read whose absence is an authorization answer.
 */
export async function firstOrNone<T>(
  pb: PocketBase,
  collection: string,
  filter: string,
): Promise<T | undefined> {
  const page = await pb.collection(collection).getList<T>(1, 1, { filter })
  return page.items[0]
}

/**
 * `getOne`, with a genuinely missing record as `undefined` rather than a throw.
 *
 * Safe where `firstOrNone` is not: fetching by primary key names one record in
 * one collection, and a caller that reaches here has already established the
 * collection exists. Anything but a 404 still throws.
 */
export async function getOneOrNone<T>(
  pb: PocketBase,
  collection: string,
  id: string,
): Promise<T | undefined> {
  try {
    return await pb.collection(collection).getOne<T>(id)
  } catch (error) {
    if (isPocketBaseNotFound(error)) return undefined
    throw error
  }
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

/** An organization. Everything a user can reach hangs off exactly one of these. */
export interface AppOrganization {
  id: string
  name: string
  created?: string
}

export type OrgRole = 'admin' | 'member'

/**
 * One user's place in one organization.
 *
 * `role` lives here rather than on `users` because `users` is the one collection
 * a visitor's own PocketBase credential can write to — see the header of
 * `1787470000_organizations.js`. A unique index on `user` is what enforces one
 * organization per user, and why accepting an invitation updates this row.
 */
export interface AppMembership {
  id: string
  org: string
  user: string
  role: OrgRole
  created?: string
}

/**
 * A grant of "may use, not manage" over one connection, to one member.
 *
 * Admins reach every connection in their organization and hold no rows here, so
 * an empty result is not the same as no access — always consult the role first.
 */
export interface AppInstanceAssignment {
  id: string
  instance: string
  user: string
  created?: string
}

/** A pending or spent invitation. `code_hash` is the SHA-256 of the link code. */
export interface AppInvitation {
  id: string
  org: string
  email: string
  role: OrgRole
  code_hash: string
  invited_by?: string
  accepted_by?: string
  expires_at?: string
  accepted_at?: string
  revoked?: boolean
  created?: string
}

/**
 * One connection. `kind` says what sort — the row's other fields are read
 * according to it, and it decides which MCP tools a token on this row can see.
 *
 * Optional in the type, and absent on any row written before `kind` existed.
 * Read it through `instanceKind()` in mcp-scope.ts rather than directly, so
 * "absent means WhatsApp" is decided in exactly one place.
 *
 * Four fields are `hidden` PocketBase fields — `api_key`, `admin_key`, `dsn` and
 * `evolution_db_url` — so they are only ever populated on records fetched
 * through `pocketbaseAdmin()`. A record from a session-scoped client will have
 * them undefined.
 *
 * `api_key` is Evolution's per-instance token. `admin_key` is a *global* key for
 * a user-supplied Evolution server and can create and delete instances on it, so
 * it is a wider secret than anything else on the row: never let it reach
 * `credentialsForInstance()`. `dsn` is a user-supplied Postgres connection
 * string, for a connection whose whole purpose is that database.
 * `evolution_db_url` is a read-only URL for a bring-your-own Evolution server's
 * own database, and reaches every account on that server rather than only this
 * one. `hidden` keeps all four out of the REST projection; it is not encryption,
 * and they sit in clear in `pb_data` and in every backup.
 */
export interface AppInstance {
  id: string
  /**
   * The owning organization. Authorization is decided against this and never
   * against `created_by`.
   */
  org: string
  /**
   * Who created the connection. Provenance only — it grants nothing, and it is
   * empty on a row whose creator has since been removed.
   */
  created_by?: string
  kind?: 'whatsapp' | 'postgres'
  name: string
  instance_id?: string
  api_key?: string
  admin_key?: string
  base_url?: string
  evolution_db_url?: string
  dsn?: string
  pg_host?: string
  pg_port?: number
  pg_database?: string
  label?: string
  created?: string
}

export interface AppMcpToken {
  id: string
  /**
   * The member this token was issued to. It authenticates only while that user
   * is still a member of the instance's organization and still reaches the
   * instance — see `resolveMcpAuth`.
   */
  assigned_to: string
  /** Who minted it. Provenance only; it confers nothing. */
  created_by?: string
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
  all_tables?: boolean
  table_names?: unknown
  all_tools?: boolean
  tool_names?: unknown
}
