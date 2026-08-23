import type { AppInstance } from './pocketbase'
import type { McpAuth } from './mcp-auth'

/**
 * The one Evolution API client. Everything funnels through
 * `createEvolutionClient`, so the base URL and the `apikey` header are defined
 * in exactly one place.
 *
 * Two kinds of credential, and the distinction is a security boundary:
 *
 *   admin     the global key from runtimeConfig. Creates and deletes instances.
 *             Two callers, both in instances.ts. Never stored on a record.
 *   instance  the per-instance token Evolution returns from /instance/create.
 *             Everything else. Evolution scopes it to that one instance itself.
 */

export interface EvolutionCredentials {
  baseUrl: string
  apiKey: string
}

export type EvolutionClient = ReturnType<typeof createEvolutionClient>

export function createEvolutionClient(creds: EvolutionCredentials) {
  return $fetch.create({
    baseURL: creds.baseUrl,
    headers: { apikey: creds.apiKey },
    retry: 0,
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
export function evolutionAdminClient(): EvolutionClient {
  const config = useRuntimeConfig()

  if (!config.evolutionUrl || !config.evolutionAdminKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'NUXT_EVOLUTION_URL / NUXT_EVOLUTION_ADMIN_KEY are not set',
    })
  }

  return createEvolutionClient({
    baseUrl: config.evolutionUrl,
    apiKey: config.evolutionAdminKey,
  })
}

/**
 * Credentials for one connected account.
 *
 * There is deliberately NO fallback to the admin key. If `api_key` is missing
 * the caller gets `undefined` and must fail. Falling back would silently give
 * an MCP token holder global Evolution access across every user's instance.
 *
 * The base URL may fall back to config: it is not a secret, and it lets an
 * existing instance keep working if the deployment URL changes.
 */
export function credentialsForInstance(instance: Pick<AppInstance, 'base_url' | 'api_key'>): EvolutionCredentials | undefined {
  const baseUrl = instance.base_url || useRuntimeConfig().evolutionUrl
  if (!baseUrl || !instance.api_key) return undefined
  return { baseUrl, apiKey: instance.api_key }
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

  return createEvolutionClient(auth.evolution)
}
