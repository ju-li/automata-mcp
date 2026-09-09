import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppUser } from './pocketbase'
import type { McpScope } from './mcp-scope'
import type { EvolutionCredentials } from './evolution'

/**
 * Auth for the MCP surface — and ONLY the MCP surface.
 *
 * This module has no access to, and no fallback to, the browser session. A
 * request that fails token auth here fails outright; it never degrades into
 * "well, there is a PocketBase cookie, use that". See server/utils/session.ts
 * for the other, entirely separate path.
 *
 * Tokens are minted by this app. A token is bound to exactly one connected
 * WhatsApp account, so the instance is implicit at every call site and no tool
 * takes an instance argument. Evolution's per-instance `apikey` is read from
 * that instance's record server-side and never leaves this process.
 */

const TOKEN_PREFIX = 'wamcp_'

interface McpAuthBase {
  user: AppUser
  instance: AppInstance
  tokenId: string
  /** Which chats, tables and tools this token may reach. See mcp-scope.ts. */
  scope: McpScope
}

/**
 * The resolved credential for one MCP request, discriminated by connection kind.
 *
 * A union rather than a bag of optional fields, so a handler that reaches for
 * `evolution` has to establish it is talking to a WhatsApp connection first —
 * the type says what the kind gate on every tool's `enabled` also says.
 *
 * Postgres carries no separate credential object: the DSN lives on the instance
 * row and `pgFor(instance)` is the only thing that reads it, so copying it here
 * would put a second live copy of a user's database password in request context
 * for no gain.
 */
export type McpAuth =
  | (McpAuthBase & { kind: 'whatsapp', evolution: EvolutionCredentials })
  | (McpAuthBase & { kind: 'postgres' })

interface McpTokenRecord {
  id: string
  user: string
  instance: string
  token_hash: string
  expires_at: string
  revoked: boolean
  all_chats?: boolean
  chat_jids?: unknown
  all_tables?: boolean
  table_names?: unknown
  all_tools?: boolean
  tool_names?: unknown
}

/** Mint a new token. The plaintext is returned once and never stored. */
export function mintMcpToken(): { token: string, hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashMcpToken(token) }
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Pull the presented token off the request.
 *
 * `Authorization: Bearer <token>` is the primary form. The `/mcp/<token>` path
 * segment is a fallback for MCP clients that cannot attach custom headers.
 */
function extractToken(event: H3Event): string | undefined {
  const header = getRequestHeader(event, 'authorization')
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1]!.trim()
    // An Authorization header that is present but malformed is a hard failure —
    // do not silently fall through to the path segment.
    return undefined
  }

  // Registered by modules/mcp-token-route.ts. Undefined on the plain /mcp route.
  const param = getRouterParam(event, 'token')
  return param ? decodeURIComponent(param) : undefined
}

/**
 * Resolve a request to a user and the one instance its token is bound to, or
 * `undefined`. Callers must treat `undefined` as 401 — never as anonymous
 * access.
 */
export async function resolveMcpAuth(event: H3Event): Promise<McpAuth | undefined> {
  const token = extractToken(event)
  if (!token || !token.startsWith(TOKEN_PREFIX)) return undefined

  const pb = await pocketbaseAdmin()

  let record: McpTokenRecord
  try {
    // Exact match on the unique token_hash index — no scan, no user-controlled
    // filter expression.
    record = await pb.collection('mcp_tokens').getFirstListItem<McpTokenRecord>(
      pb.filter('token_hash = {:hash}', { hash: hashMcpToken(token) }),
    )
  } catch (error) {
    // 404 means no such token — that is a real auth failure. Anything else
    // (PocketBase down, network error, 500) is our problem, not the caller's:
    // answering 401 there would tell a client its valid token had been revoked
    // and invite it to throw the token away.
    if (isPocketBaseNotFound(error)) return undefined
    throw backendUnavailable(error)
  }

  // Defence in depth: the lookup above already proves equality, but compare the
  // stored hash explicitly so a future change to the query cannot weaken this.
  const presented = Buffer.from(hashMcpToken(token))
  const stored = Buffer.from(record.token_hash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return undefined
  }

  if (record.revoked) return undefined
  if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
    return undefined
  }

  let instance: AppInstance
  let user: AppUser
  try {
    // The instance carries the Evolution credentials. `api_key` is a hidden
    // PocketBase field, so this only works through the admin client.
    instance = await pb.collection('instances').getOne<AppInstance>(record.instance)
    user = await pb.collection('users').getOne<AppUser>(record.user)
  } catch (error) {
    if (isPocketBaseNotFound(error)) return undefined
    throw backendUnavailable(error)
  }

  // A token cannot outlive its instance's owner changing underneath it.
  if (instance.user !== user.id) return undefined

  // Per-kind credentials. A missing one means the connection was never finished,
  // which is a genuine "this credential does not work" and so a 401 — not the
  // 503 that a backend outage gets. It is also invisible in the logs otherwise,
  // and "my token stopped working" with nothing in the logs is the failure that
  // rule exists to prevent, so say which connection and why.
  const kind = instanceKind(instance)
  const base = { user, instance, tokenId: record.id, scope: scopeFromRecord(record) }

  let auth: McpAuth
  if (kind === 'postgres') {
    if (!instance.dsn) {
      console.error(`[mcp-auth] instance ${instance.id} is kind=postgres with no dsn; token ${record.id} refused`)
      return undefined
    }
    auth = { ...base, kind: 'postgres' }
  }
  else {
    const evolution = credentialsForInstance(instance)
    if (!evolution) {
      console.error(`[mcp-auth] instance ${instance.id} has no Evolution credentials; token ${record.id} refused`)
      return undefined
    }
    auth = { ...base, kind: 'whatsapp', evolution }
  }

  // Best-effort; a write failure must not fail an otherwise valid request.
  void pb.collection('mcp_tokens')
    .update(record.id, { last_used_at: new Date().toISOString() })
    .catch(() => {})

  return auth
}

/**
 * The authenticated instance, for MCP tool handlers.
 *
 * Same async-context mechanism as `useEvolutionClient()`: the MCP SDK calls
 * handlers without an H3 event, so `useEvent()` recovers it. Fails closed if the
 * auth middleware was somehow bypassed.
 */
export function useMcpAuth(): McpAuth {
  const event = useEvent()
  const auth = event.context.mcpAuth as McpAuth | undefined
  if (!auth) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return auth
}

function backendUnavailable(cause: unknown) {
  return createError({
    statusCode: 503,
    statusMessage: 'Auth backend unavailable',
    cause,
  })
}

/**
 * 401 with a `WWW-Authenticate` challenge, shaped as a JSON-RPC error so MCP
 * clients can surface something useful. Never return 200 on an auth failure —
 * a 200 with an error body reads as "the tool ran and said no".
 */
export function mcpUnauthorized(reason = 'invalid_token'): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized' },
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="claude-whatsapp-mcp", error="${reason}"`,
      },
    },
  )
}
