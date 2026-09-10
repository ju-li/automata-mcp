import type { AppInstance } from './pocketbase'
import type { McpAuth } from './mcp-auth'

/**
 * The one Evolution API client. Everything funnels through
 * `createEvolutionClient`, so the base URL and the `apikey` header are defined
 * in exactly one place.
 *
 * Two kinds of credential, and the distinction is a security boundary:
 *
 *   admin     a *global* key. Creates and deletes instances. Two callers, both
 *             in instances.ts. Either the deployment's own key from
 *             runtimeConfig, or a key the user supplied for their own server —
 *             and the two are never cross-paired, see
 *             `evolutionAdminCredentials`.
 *   instance  the per-instance token Evolution returns from /instance/create.
 *             Everything else. Evolution scopes it to that one instance itself.
 *
 * A third distinction cuts across both: whether the base URL came from this
 * deployment's configuration or from a user. A user-supplied one is an
 * outbound request to an address a user chose, so it goes through the host
 * guard — see `userSupplied` below.
 */

export interface EvolutionCredentials {
  baseUrl: string
  apiKey: string
  /**
   * True when `baseUrl` came from a user rather than from runtimeConfig.
   *
   * Only these are guarded. Our own configured Evolution URL must NOT be: it
   * legitimately sits on a private compose network, and `net-guard` would
   * (correctly) refuse it as this deployment's own infrastructure.
   */
  userSupplied?: boolean
}

export type EvolutionClient = ReturnType<typeof createEvolutionClient>

export function createEvolutionClient(creds: EvolutionCredentials) {
  return $fetch.create({
    baseURL: creds.baseUrl,
    headers: { apikey: creds.apiKey },
    retry: 0,

    /**
     * Host guard for user-supplied servers, re-checked on every request rather
     * than only when the URL was saved. A hostname that passed at save time can
     * be re-pointed at 127.0.0.1 afterwards, and nothing would notice.
     *
     * **This checks; it does not pin.** `$fetch` resolves DNS itself, so a name
     * that answers publicly here and privately a millisecond later still wins —
     * a rebinding window this cannot close. Closing it needs the connection to
     * be dialled at the address we approved, which for HTTP means an undici
     * `Agent` with a `connect` hook (`undici` is not a direct dependency today);
     * `pg-pool.ts` does exactly that for Postgres, where postgres.js takes a
     * `host` option and no extra dependency is needed. The database path is the
     * wider exposure of the two, and it is the one that is pinned.
     */
    async onRequest({ options }) {
      if (!creds.userSupplied) return
      await assertPublicUrl(creds.baseUrl, 'Evolution server URL')
      // Refuse a redirect off the approved host rather than following it.
      options.redirect = 'error'
    },
  })
}

/**
 * Global-key client. Only `POST /instance/create` and `DELETE /instance/delete`
 * require it — Evolution's auth guard accepts an instance's own token for every
 * other route.
 *
 * Do not reach for this anywhere else. A request authenticated with this key
 * can see and act on every user's instance.
 */
export function evolutionAdminCredentials(
  server?: Pick<AppInstance, 'base_url' | 'admin_key'>,
): EvolutionCredentials | undefined {
  const config = useRuntimeConfig()

  // A row that carries its own global key is a bring-your-own server, and both
  // halves come from it.
  if (server?.admin_key) {
    if (!server.base_url) return undefined
    return { baseUrl: server.base_url, apiKey: server.admin_key, userSupplied: true }
  }

  // No key on the row: this connection uses the deployment default. `base_url`
  // is stored on EVERY row, including these, so its mere presence does not make
  // a row bring-your-own — reading it that way refuses to delete an ordinary
  // connection, which is exactly the bug this comment replaced.
  //
  // But a row naming a *different* server with no key of its own is genuinely
  // unusable, and must not be completed from ours: sending our global key to a
  // server the user chose hands them a credential that reaches every account on
  // our Evolution. That is the case this returns undefined for.
  if (server?.base_url && config.evolutionUrl && server.base_url !== config.evolutionUrl) {
    return undefined
  }

  if (!config.evolutionUrl || !config.evolutionAdminKey) return undefined
  return { baseUrl: config.evolutionUrl, apiKey: config.evolutionAdminKey }
}

/**
 * Client for the global key of whichever server this instance lives on.
 *
 * Throws 422, not 500: with the Evolution variables now optional, "no server
 * configured" is a thing the caller can fix by supplying one, not a broken
 * deployment.
 */
export function evolutionAdminClient(
  server?: Pick<AppInstance, 'base_url' | 'admin_key'>,
): EvolutionClient {
  const creds = evolutionAdminCredentials(server)
  if (!creds) {
    throw createError({
      statusCode: 422,
      statusMessage: 'No Evolution server is available for this connection. '
        + 'Set NUXT_EVOLUTION_URL and NUXT_EVOLUTION_ADMIN_KEY to provide a default, '
        + 'or supply your own server URL and admin key when creating the connection.',
    })
  }
  return createEvolutionClient(creds)
}

/**
 * Credentials for one connected account.
 *
 * There is deliberately NO fallback to a global key. If `api_key` is missing
 * the caller gets `undefined` and must fail. Falling back would silently give
 * an MCP token holder global Evolution access across every user's instance.
 *
 * That now has a sharper edge: `instance.admin_key` is a global key sitting on
 * the very record this function reads. It must never be read here. The type
 * below picks its two fields deliberately so `admin_key` is not even in scope.
 *
 * The base URL may fall back to config: it is not a secret, and it lets an
 * existing instance keep working if the deployment URL changes.
 */
export function credentialsForInstance(instance: Pick<AppInstance, 'base_url' | 'api_key'>): EvolutionCredentials | undefined {
  const configUrl = useRuntimeConfig().evolutionUrl
  const baseUrl = instance.base_url || configUrl
  if (!baseUrl || !instance.api_key) return undefined
  // Anything that is not the server we configured is a server a user chose, so
  // it is guarded. Derived rather than stored, so a row that stops matching our
  // configuration starts being guarded rather than quietly staying exempt.
  return { baseUrl, apiKey: instance.api_key, userSupplied: baseUrl !== configUrl }
}

/** For UI API routes, where the instance came from `pocketbaseAdmin()`. */
export function evolutionClientForInstance(instance: AppInstance): EvolutionClient {
  const creds = credentialsForInstance(instance)
  if (!creds) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This WhatsApp account is not fully provisioned',
    })
  }
  return createEvolutionClient(creds)
}

/**
 * For MCP tool handlers.
 *
 * Tool handlers are called by the MCP SDK with its own `RequestHandlerExtra` —
 * there is no H3 event in scope. `useEvent()` recovers it from Nitro's async
 * context, which is why `nitro.experimental.asyncContext` is enabled in
 * nuxt.config.ts.
 *
 * Reads `event.context.mcpAuth` and nothing else. There is no branch here that
 * can reach a browser session; that separation is the point.
 */
export function useEvolutionClient(): EvolutionClient {
  const event = useEvent()
  const auth = event.context.mcpAuth as McpAuth | undefined

  if (!auth) {
    // Unreachable in practice — server/mcp/index.ts returns 401 before any tool
    // is registered. If it ever fires, something bypassed the auth middleware,
    // and failing closed is the only correct response.
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  if (auth.kind !== 'whatsapp') {
    // Also unreachable: every tool that calls this is gated on kind in its
    // `enabled` guard. Fail closed anyway — reaching Evolution on behalf of a
    // connection that is not a WhatsApp account has no correct meaning.
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  return createEvolutionClient(auth.evolution)
}
