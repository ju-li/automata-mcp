import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppUser } from './pocketbase'
import type { EvolutionCredentials } from './evolution'

/**
 * Auth for the MCP surface — and ONLY the MCP surface.
 *
 * This module has no access to, and no fallback to, the browser session. A
 * request that fails token auth here fails outright; it never degrades into
 * "well, there is a PocketBase cookie, use that". See server/utils/session.ts
 * for the other, entirely separate path.
 *
 * Tokens are minted by this app. They are not Evolution's `apikey` — that stays
 * on the user record, server-side.
 */

const TOKEN_PREFIX = 'wamcp_'

export interface McpAuth {
  user: AppUser
  tokenId: string
  evolution: EvolutionCredentials
}

interface McpTokenRecord {
  id: string
  user: string
  token_hash: string
  expires_at: string
  revoked: boolean
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
 * Resolve a request to a user, or `undefined`. Callers must treat `undefined`
 * as 401 — never as anonymous access.
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
    if (isNotFound(error)) return undefined
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

  let user: AppUser
  try {
    user = await pb.collection('users').getOne<AppUser>(record.user)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw backendUnavailable(error)
  }

  const evolution = evolutionCredentialsFor(user)
  if (!evolution) return undefined

  // Best-effort; a write failure must not fail an otherwise valid request.
  void pb.collection('mcp_tokens')
    .update(record.id, { last_used_at: new Date().toISOString() })
    .catch(() => {})

  return { user, tokenId: record.id, evolution }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 404
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
