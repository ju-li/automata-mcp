import { assertNever } from '#shared/connection'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppMcpToken, AppUser, OrgLimits, OrgRole } from './app-db'
import type { McpScope } from './mcp-scope'
import type { EvolutionCredentials } from './evolution'
import type { TelegramCredentials } from './telegram'

/**
 * Auth for the MCP surface — and ONLY the MCP surface.
 *
 * This module has no access to, and no fallback to, the browser session. A
 * request that fails token auth here fails outright; it never degrades into
 * "well, there is a session cookie, use that". See server/utils/session.ts
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
  /**
   * The holder's organization's connection and token limits, read on the same
   * query as everything else here. Both undefined — every self-hosted
   * organization — means unlimited. Enforced by `mcpLimitRefusal`.
   */
  limits: Pick<OrgLimits, 'max_connections' | 'max_tokens'>
  /**
   * The line the send tools append to every message, chosen by an admin when
   * the token was minted or edited. Read with everything else, so a change
   * applies from the next request. Undefined = off.
   */
  sendDisclaimer?: string
  /** Set when this connection is one of several an OAuth sign-in covers. */
  oauthSessionId?: string
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
 * for no gain. IMAP follows the same rule for the mailbox password, which only
 * imap-client.ts reads.
 */
export type McpAuth =
  | (McpAuthBase & { kind: 'whatsapp', evolution: EvolutionCredentials })
  | (McpAuthBase & { kind: 'postgres' })
  | (McpAuthBase & { kind: 'telegram', telegram: TelegramCredentials })
  | (McpAuthBase & { kind: 'imap' })

/**
 * One row per token, joined to everything that decides whether it still works.
 * The joins are LEFT so a missing piece reads as a missing piece (and is logged
 * as one) rather than as no such token.
 */
interface McpTokenFacts extends Pick<AppMcpToken,
  'id' | 'assigned_to' | 'instance' | 'token_hash' | 'expires_at' | 'revoked'
  | 'all_chats' | 'chat_jids' | 'all_tables' | 'table_names' | 'all_tools' | 'tool_names'
  | 'send_disclaimer' | 'auth_method' | 'oauth_session'> {
  user_email?: string
  user_name?: string
  member_role?: OrgRole
  member_org?: string
  max_connections?: number
  max_tokens?: number
  assigned: boolean
  /** The connection's OAuth ceiling for members; absent = none set (closed). */
  policy_members_allowed?: boolean
  policy_all_chats?: boolean
  policy_chat_jids?: unknown
  policy_all_tables?: boolean
  policy_table_names?: unknown
  policy_all_tools?: boolean
  policy_tool_names?: unknown
  policy_send_disclaimer?: string
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
 * `Authorization: Bearer <token>` is the primary form. A bare
 * `Authorization: wamcp_…` is accepted too: gateways such as Smithery forward a
 * user-entered value into the header verbatim, with no scheme. Only a value
 * carrying our own prefix qualifies, so no other scheme is reinterpreted. The
 * `/mcp/<token>` path segment is a fallback for MCP clients that cannot attach
 * custom headers.
 */
function extractToken(event: H3Event): { token: string, from: 'header' | 'path' } | undefined {
  const header = getRequestHeader(event, 'authorization')
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return { token: match[1]!.trim(), from: 'header' }
    if (header.trim().startsWith(TOKEN_PREFIX)) return { token: header.trim(), from: 'header' }
    // An Authorization header that is present but malformed is a hard failure —
    // do not silently fall through to the path segment.
    return undefined
  }

  // Registered by modules/mcp-token-route.ts. Undefined on the plain /mcp route.
  const param = getRouterParam(event, 'token')
  return param ? { token: decodeURIComponent(param), from: 'path' } : undefined
}

/**
 * What an MCP request authenticated as.
 *
 * `token`: a static connector token — one connection, exactly as before OAuth.
 * `session`: an OAuth sign-in covering one or more connections, each its own
 * `McpAuth` resolved through the same checks a static token gets. Tools are
 * generated per connection for a session (`mcp-session-tools.ts`), so no tool
 * ever sees more than one connection.
 */
export type McpCredential =
  | { type: 'token', auth: McpAuth }
  | { type: 'session', sessionId: string, user: AppUser, clientName: string, connections: McpAuth[] }

/**
 * The connection a tool call is acting for, for the duration of that call.
 *
 * A static token sets `event.context.mcpAuth` once; an OAuth session has several
 * connections on one request, so each generated tool runs its handler inside
 * `mcpAuthContext.run(connection, …)`. Per call rather than written onto the
 * shared event, because a JSON-RPC batch can run several calls at once.
 */
export const mcpAuthContext = new AsyncLocalStorage<McpAuth>()

/**
 * The connection the current tool call acts for: the per-call context when an
 * OAuth session's generated tool is running, else the static token's. Every
 * MCP-side reader goes through this — never the browser session.
 */
export function currentMcpAuth(event?: H3Event): McpAuth | undefined {
  const scoped = mcpAuthContext.getStore()
  if (scoped) return scoped
  const source = event ?? useEvent()
  return source.context.mcpAuth as McpAuth | undefined
}

/**
 * The columns every token check needs, joined LEFT so a missing piece reads as
 * a missing piece (and is logged as one) rather than as no such token. The
 * policy columns matter only for an OAuth child held by a member.
 */
function tokenFactsSelect(sql: Awaited<ReturnType<typeof appDb>>) {
  return sql`
    SELECT t.id, t.assigned_to, t.instance, t.token_hash, t.expires_at, t.revoked,
           t.all_chats, t.chat_jids, t.all_tables, t.table_names, t.all_tools, t.tool_names,
           t.send_disclaimer, t.auth_method, t.oauth_session,
           u.email AS user_email, u.name AS user_name,
           m.role AS member_role, m.org AS member_org,
           o.max_connections, o.max_tokens,
           EXISTS (
             SELECT 1 FROM app.instance_assignments a
             WHERE a.user_id = t.assigned_to AND a.instance = t.instance
           ) AS assigned,
           p.members_allowed AS policy_members_allowed,
           p.all_chats AS policy_all_chats, p.chat_jids AS policy_chat_jids,
           p.all_tables AS policy_all_tables, p.table_names AS policy_table_names,
           p.all_tools AS policy_all_tools, p.tool_names AS policy_tool_names,
           p.send_disclaimer AS policy_send_disclaimer
    FROM app.mcp_tokens t
    LEFT JOIN app.users u ON u.id = t.assigned_to
    LEFT JOIN app.memberships m ON m.user_id = t.assigned_to
    LEFT JOIN app.organizations o ON o.id = m.org
    LEFT JOIN app.connection_oauth_policy p ON p.instance = t.instance
  `
}

/**
 * Resolve a request to what it authenticated as, or `undefined`. Callers must
 * treat `undefined` as 401 — never as anonymous access.
 */
export async function resolveMcpCredential(event: H3Event): Promise<McpCredential | undefined> {
  const presented = extractToken(event)
  if (!presented) return undefined

  if (presented.token.startsWith(ACCESS_TOKEN_PREFIX)) {
    // OAuth access tokens travel in the header only (the resource metadata
    // says `bearer_methods_supported: header`), never in a URL that ends up in
    // logs and browser history.
    if (presented.from !== 'header') return undefined
    return await resolveOAuthSession(presented.token)
  }
  if (!presented.token.startsWith(TOKEN_PREFIX)) return undefined
  const auth = await resolveMcpAuth(presented.token)
  return auth ? { type: 'token', auth } : undefined
}

/**
 * Resolve a static token to its one connection, or `undefined`.
 */
async function resolveMcpAuth(token: string): Promise<McpAuth | undefined> {
  // ── who this token still reaches ─────────────────────────────────────────
  //
  // A token names a member and a connection. It authenticates only while that
  // member is still in the connection's organization and still reaches the
  // connection — so removing someone, or unassigning a connection from them,
  // kills their tokens on the very next request even if an explicit revoke was
  // missed. That is the whole reason this is read live and neither cached nor
  // denormalized onto the token: a cache would delay exactly the effect this
  // exists to produce, and a copied `org` would go stale on every one of those
  // transitions.
  //
  // One query for the token and the facts about its holder, then the instance
  // row by primary key. Failure semantics, which are the point of this block:
  //
  //   no such token hash               → 401           not a credential
  //   any read THROWS                  → 503           an outage, not a revocation
  //   holder or instance row gone      → 401           a dead credential
  //   no membership                    → 401, logged   the holder is in no org
  //   membership.org !== instance.org  → 401, logged   they left the org
  //   no assignment, role member       → 401, logged   assignment revoked
  //   role admin                       → authorized, assignments not consulted
  const hash = hashMcpToken(token)
  let record: McpTokenFacts | undefined
  let instance: AppInstance | undefined
  try {
    const sql = await appDb()
    ;[record] = await sql<McpTokenFacts[]>`${tokenFactsSelect(sql)} WHERE t.token_hash = ${hash}`
    if (record) instance = await getRow<AppInstance>('instances', record.instance)
  } catch (error) {
    // Answering 401 here would tell a client its valid token had been revoked
    // and invite it to throw the token away.
    console.error('[mcp-auth] could not resolve a token against the app database:', error)
    throw appDbUnavailable(error)
  }

  if (!record) return undefined

  // Defence in depth: the lookup above already proves equality, but compare the
  // stored hash explicitly so a future change to the query cannot weaken this.
  const presentedHash = Buffer.from(hash)
  const stored = Buffer.from(record.token_hash ?? '')
  if (presentedHash.length !== stored.length || !timingSafeEqual(presentedHash, stored)) {
    return undefined
  }
  if (record.auth_method !== 'static') return undefined

  const auth = authorizeTokenFacts(record, instance)
  if (auth) touchTokens([record.id])
  return auth
}

/**
 * Resolve an OAuth access token to its session and the connections it still
 * reaches.
 *
 * Each connection goes through `authorizeTokenFacts` — the very checks a static
 * token gets — and then, for a member, through the connection's current
 * ceiling. One that fails is **dropped and logged**, never failing the request:
 * unassigning one connection must not take the user's other connections down
 * with it. With none left the answer is 401, which sends the client back to
 * sign in, where the consent page says what is still available.
 */
async function resolveOAuthSession(token: string): Promise<McpCredential | undefined> {
  const hash = hashMcpToken(token)
  let session: { id: string, user_id: string, access_expires_at?: string, client_name?: string, email?: string, name?: string } | undefined
  let rows: McpTokenFacts[] = []
  let instances: AppInstance[] = []
  try {
    const sql = await appDb()
    ;[session] = await sql`
      SELECT s.id, s.user_id, s.access_expires_at, c.name AS client_name, u.email, u.name
      FROM app.oauth_sessions s
      JOIN app.oauth_clients c ON c.id = s.client
      JOIN app.users u ON u.id = s.user_id
      WHERE s.token_hash = ${hash}
    `
    if (session) {
      rows = await sql<McpTokenFacts[]>`
        ${tokenFactsSelect(sql)}
        WHERE t.oauth_session = ${session.id} AND NOT t.revoked
        ORDER BY t.created, t.id
      `
      if (rows.length) {
        instances = await sql<AppInstance[]>`SELECT * FROM app.instances WHERE id = ANY(${rows.map(r => r.instance)})`
      }
    }
  } catch (error) {
    console.error('[mcp-auth] could not resolve an OAuth session against the app database:', error)
    throw appDbUnavailable(error)
  }

  if (!session) return undefined
  // An access token lives an hour; past that the client refreshes, which the
  // 401 prompts. A missing expiry is refused, never read as "forever".
  if (!session.access_expires_at || new Date(session.access_expires_at).getTime() <= Date.now()) {
    return undefined
  }

  const byId = new Map(instances.map(i => [i.id, i]))
  const connections: McpAuth[] = []
  for (const record of rows) {
    if (record.assigned_to !== session.user_id) continue
    const auth = authorizeTokenFacts(record, byId.get(record.instance))
    if (!auth) continue

    // A member's connection answers within the connection's *current* ceiling,
    // so an admin narrowing or switching it off takes effect now.
    if (record.member_role !== 'admin') {
      if (!record.policy_members_allowed) {
        console.error(`[mcp-auth] connection ${record.instance} no longer allows members to sign in; OAuth connection ${record.id} dropped from session ${session.id}`)
        continue
      }
      const ceiling = scopeFromRecord({
        all_chats: record.policy_all_chats,
        chat_jids: record.policy_chat_jids,
        all_tables: record.policy_all_tables,
        table_names: record.policy_table_names,
        all_tools: record.policy_all_tools,
        tool_names: record.policy_tool_names,
      })
      auth.scope = intersectScope(auth.scope, ceiling)
      auth.sendDisclaimer = record.policy_send_disclaimer || undefined
    }
    auth.oauthSessionId = session.id
    connections.push(auth)
  }

  if (connections.length === 0) {
    console.error(`[mcp-auth] OAuth session ${session.id} reaches no connection any more; refused`)
    return undefined
  }

  touchTokens(connections.map(c => c.tokenId), session.id)
  return {
    type: 'session',
    sessionId: session.id,
    user: { id: session.user_id, email: session.email ?? '', name: session.name },
    clientName: session.client_name || 'an app',
    connections,
  }
}

/** Best-effort; a write failure must not fail an otherwise valid request. */
function touchTokens(tokenIds: string[], sessionId?: string): void {
  void appDb()
    .then(async (sql) => {
      await sql`UPDATE app.mcp_tokens SET last_used_at = now() WHERE id = ANY(${tokenIds})`
      if (sessionId) await sql`UPDATE app.oauth_sessions SET last_used_at = now() WHERE id = ${sessionId}`
    })
    .catch(() => {})
}

/**
 * Everything after the lookup: is this token row, for this connection, still a
 * working credential? Shared by static tokens and OAuth children, so the two
 * cannot drift on who may reach what.
 */
function authorizeTokenFacts(record: McpTokenFacts, instance: AppInstance | undefined): McpAuth | undefined {
  if (record.revoked) return undefined
  if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
    return undefined
  }

  // The token points at a row that is gone. A dead credential, not an outage.
  if (!instance || !record.user_email) return undefined
  const user: AppUser = { id: record.assigned_to, email: record.user_email, name: record.user_name }

  if (!record.member_role || !record.member_org) {
    console.error(`[mcp-auth] user ${record.assigned_to} is in no organization; token ${record.id} refused`)
    return undefined
  }

  // The rule itself lives in org.ts and is shared verbatim with the web UI, so
  // the two surfaces cannot drift on who may reach what while still loading
  // their own facts through their own credential path.
  if (!authorizesInstance(
    { role: record.member_role, orgId: record.member_org },
    instance.org,
    record.assigned,
  )) {
    console.error(
      `[mcp-auth] user ${user.id} (${record.member_role}, org ${record.member_org}) `
      + `does not reach instance ${instance.id} (org ${instance.org}); token ${record.id} refused`,
    )
    return undefined
  }

  // Per-kind credentials. A missing one means the connection was never finished,
  // which is a genuine "this credential does not work" and so a 401 — not the
  // 503 that a backend outage gets. It is also invisible in the logs otherwise,
  // and "my token stopped working" with nothing in the logs is the failure that
  // rule exists to prevent, so say which connection and why.
  // A kind this build cannot interpret is refused, never guessed at — see
  // `instanceKind()`. `instanceKind` has already logged which value it was.
  let kind: InstanceKind
  try {
    kind = instanceKind(instance)
  }
  catch {
    console.error(`[mcp-auth] instance ${instance.id} has an unsupported kind; token ${record.id} refused`)
    return undefined
  }
  const base = {
    user,
    instance,
    tokenId: record.id,
    scope: scopeFromRecord(record),
    sendDisclaimer: record.send_disclaimer || undefined,
    limits: { max_connections: record.max_connections, max_tokens: record.max_tokens },
  }

  let auth: McpAuth
  switch (kind) {
    case 'postgres': {
      if (!instance.dsn) {
        console.error(`[mcp-auth] instance ${instance.id} is kind=postgres with no dsn; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'postgres' }
      break
    }
    case 'whatsapp': {
      const evolution = credentialsForInstance(instance)
      if (!evolution) {
        console.error(`[mcp-auth] instance ${instance.id} has no Evolution credentials; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'whatsapp', evolution }
      break
    }
    case 'telegram': {
      const telegram = telegramCredentialsForInstance(instance)
      if (!telegram) {
        console.error(`[mcp-auth] instance ${instance.id} has no Telegram bridge credentials; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'telegram', telegram }
      break
    }
    case 'imap': {
      if (!instance.imap_host || !instance.imap_user) {
        console.error(`[mcp-auth] instance ${instance.id} is kind=imap with no mailbox; token ${record.id} refused`)
        return undefined
      }
      auth = { ...base, kind: 'imap' }
      break
    }
    default:
      return assertNever(kind, 'connection kind')
  }

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
  const auth = currentMcpAuth()
  if (!auth) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return auth
}

/**
 * 401 with a `WWW-Authenticate` challenge, shaped as a JSON-RPC error so MCP
 * clients can surface something useful. Never return 200 on an auth failure —
 * a 200 with an error body reads as "the tool ran and said no".
 */
export function mcpUnauthorized(event?: H3Event, reason = 'invalid_token'): Response {
  // Point OAuth-capable clients at discovery (RFC 9728), so a 401 on plain
  // `/mcp` is where signing in starts. Not on `/mcp/<token>`: that URL is not
  // the resource the metadata names, and a client holding a dead path token
  // needs a new token, not a sign-in against a different address.
  const metadata = event && !getRouterParam(event, 'token') ? resourceMetadataUrl() : undefined
  const challenge = `Bearer realm="claude-whatsapp-mcp", error="${reason}"`
    + (metadata ? `, resource_metadata="${metadata}"` : '')
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
        'www-authenticate': challenge,
      },
    },
  )
}
