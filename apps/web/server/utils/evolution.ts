import type { AppUser } from './pocketbase'
import type { McpAuth } from './mcp-auth'

/**
 * The one Evolution API client. Both surfaces go through `createEvolutionClient`,
 * so the base URL and the `apikey` header are defined in exactly one place.
 *
 *   MCP tools      -> useEvolutionClient()        (credentials from the bearer token)
 *   UI API routes  -> evolutionClientForUser()    (credentials from the session user)
 *
 * The two accessors do not share a resolution path. `useEvolutionClient()` reads
 * `event.context.mcpAuth` and nothing else — there is no branch in it that can
 * reach a browser session.
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
 * Per-user Evolution credentials, falling back to the dev-only instance-wide
 * values from runtimeConfig. Returns `undefined` when neither is configured.
 */
export function evolutionCredentialsFor(user: Pick<AppUser, 'evolution_url' | 'evolution_api_key'>): EvolutionCredentials | undefined {
  const config = useRuntimeConfig()
  const baseUrl = user.evolution_url || config.evolutionUrl
  const apiKey = user.evolution_api_key || config.evolutionApiKey
  if (!baseUrl || !apiKey) return undefined
  return { baseUrl, apiKey }
}

/**
 * For MCP tool handlers.
 *
 * Tool handlers are called by the MCP SDK with its own `RequestHandlerExtra` —
 * there is no H3 event in scope. `useEvent()` recovers it from Nitro's async
 * context, which is why `nitro.experimental.asyncContext` is enabled in
 * nuxt.config.ts.
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

/** For UI API routes, where the caller is a PocketBase session user. */
export function evolutionClientForUser(user: AppUser): EvolutionClient {
  const creds = evolutionCredentialsFor(user)
  if (!creds) {
    throw createError({
      statusCode: 400,
      statusMessage: 'No Evolution API credentials configured for this account',
    })
  }
  return createEvolutionClient(creds)
}
