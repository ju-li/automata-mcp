import type { AppMcpToken } from './pocketbase'
import type { McpScope } from './mcp-scope'
import type { ScopeInput } from './scope-schema'

/**
 * MCP token CRUD.
 *
 * Authorization is NOT decided here any more — `resolveTokenForActor()` in
 * `org.ts` does it, and every mutating function below takes a token record that
 * has already been through it. What stays here is the rule that a read is always
 * a predicate in the query: `listTokens` narrows to one connection and, for a
 * member, to their own tokens, in the `filter` rather than by dropping rows
 * afterwards. Filters use `pb.filter()` bindings — the admin client must never
 * receive a filter string built by concatenating user input.
 */

/** What the UI may see. `token_hash` is never included. */
export interface PublicToken {
  id: string
  label: string
  created?: string
  last_used_at?: string
  expires_at?: string
  revoked: boolean
  expired: boolean
  /** Wire shape, identical to what create and patch accept. */
  scope: ScopeInput
}

export function toPublicToken(token: AppMcpToken): PublicToken {
  const expired = Boolean(token.expires_at) && new Date(token.expires_at!).getTime() <= Date.now()
  return {
    id: token.id,
    label: token.label || 'Untitled token',
    created: token.created,
    last_used_at: token.last_used_at || undefined,
    expires_at: token.expires_at || undefined,
    revoked: Boolean(token.revoked),
    expired,
    scope: scopeToInput(scopeFromRecord(token)),
  }
}

/**
 * The tokens on one connection.
 *
 * `assignedTo` narrows to one member's own, which is what a member gets: a token
 * label names where a colleague runs Claude, and `last_used_at` and the scope of
 * an admin's own token are not theirs to read. Admins pass nothing and see all
 * of them.
 */
export async function listTokens(
  instanceId: string,
  options: { assignedTo?: string } = {},
): Promise<PublicToken[]> {
  const pb = await pocketbaseAdmin()

  const filter = options.assignedTo
    ? pb.filter('instance = {:iid} && assigned_to = {:uid}', { iid: instanceId, uid: options.assignedTo })
    : pb.filter('instance = {:iid}', { iid: instanceId })

  const rows = await pb.collection('mcp_tokens').getFullList<AppMcpToken>({
    filter,
    sort: '-created',
  })
  return rows.map(toPublicToken)
}

/** Expiry presets offered by the UI. `never` leaves `expires_at` empty. */
export type ExpiryPreset = '30d' | '90d' | '1y' | 'never'

function expiryFromPreset(preset: ExpiryPreset): string {
  if (preset === 'never') return ''
  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 365
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * The scope columns, as PocketBase wants them.
 *
 * Always writes all six. PocketBase stores an unset boolean as `false`, so
 * omitting `all_tools` here would mint a token that can call nothing — a silent,
 * confusing failure rather than a loud one. The same is true of every axis that
 * gets added: write them all, every time, whatever kind the connection is.
 */
function scopeFields(scope: McpScope) {
  return {
    all_chats: scope.allChats,
    chat_jids: scope.allChats ? [] : scope.chatJids,
    all_tables: scope.allTables,
    table_names: scope.allTables ? [] : scope.tableNames,
    all_tools: scope.allTools,
    tool_names: scope.allTools ? [] : scope.toolNames,
  }
}

/**
 * Mint a token. The plaintext is returned to the caller once, here, and is not
 * recoverable afterwards — only its SHA-256 hash is stored.
 */
export interface CreateTokenInput {
  instanceId: string
  /** The member it is issued to. Their membership and access are what keep it alive. */
  assignedTo: string
  /** Who minted it. Provenance only. */
  createdBy: string
  label: string
  preset: ExpiryPreset
  scope: McpScope
}

export async function createToken(input: CreateTokenInput): Promise<{ token: string, record: PublicToken }> {
  const { token, hash } = mintMcpToken()
  const pb = await pocketbaseAdmin()

  const record = await pb.collection('mcp_tokens').create<AppMcpToken>({
    assigned_to: input.assignedTo,
    created_by: input.createdBy,
    instance: input.instanceId,
    token_hash: hash,
    label: input.label.trim() || 'Untitled token',
    expires_at: expiryFromPreset(input.preset),
    revoked: false,
    ...scopeFields(input.scope),
  })

  return { token, record: toPublicToken(record) }
}

/**
 * Change a token's scope without reissuing it.
 *
 * The connector already configured in Claude keeps working; only what it may
 * reach changes, from the next request onward. Scope is read fresh on every MCP
 * request, so there is nothing to invalidate.
 */
export async function updateTokenScope(token: AppMcpToken, scope: McpScope): Promise<PublicToken> {
  const pb = await pocketbaseAdmin()
  const record = await pb.collection('mcp_tokens').update<AppMcpToken>(token.id, scopeFields(scope))
  return toPublicToken(record)
}

/**
 * Revoke rather than delete: access stops immediately, and the row survives so
 * `last_used_at` stays available as an audit trail.
 *
 * Takes a record the caller has already resolved through
 * `resolveTokenForActor()` — this function makes no authorization decision of
 * its own, which is also why it is safe to call in bulk when a member is
 * removed or unassigned.
 */
export async function revokeToken(token: AppMcpToken): Promise<void> {
  const pb = await pocketbaseAdmin()
  await pb.collection('mcp_tokens').update(token.id, { revoked: true })
}

/**
 * Revoke every live token one member holds, optionally narrowed to one
 * connection.
 *
 * Used wherever an action would otherwise leave a token that still reads
 * "Active" in the UI and answers 401 on the wire: removing a member, demoting
 * an admin, unassigning a connection. Returns how many were revoked so the
 * caller can say so.
 */
export async function revokeTokensFor(
  userId: string,
  options: { instanceId?: string } = {},
): Promise<number> {
  const pb = await pocketbaseAdmin()

  const filter = options.instanceId
    ? pb.filter('assigned_to = {:uid} && instance = {:iid} && revoked != true', { uid: userId, iid: options.instanceId })
    : pb.filter('assigned_to = {:uid} && revoked != true', { uid: userId })

  const rows = await pb.collection('mcp_tokens').getFullList<AppMcpToken>({ filter })
  for (const row of rows) {
    await pb.collection('mcp_tokens').update(row.id, { revoked: true })
  }
  return rows.length
}
