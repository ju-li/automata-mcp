import { assertNever } from '#shared/connection'
import { tools } from '#nuxt-mcp-toolkit/tools.mjs'
import type { AppInstance, AppMcpToken, Db } from './app-db'
import type { InstanceKind, McpScope } from './mcp-scope'
import type { Actor } from './org'
import type { ScopeInput } from './scope-schema'

/**
 * MCP token CRUD.
 *
 * Authorization is NOT decided here any more — `resolveTokenForActor()` in
 * `org.ts` does it, and every mutating function below takes a token record that
 * has already been through it. What stays here is the rule that a read is always
 * a predicate in the query: `listTokens` narrows to one connection and, for a
 * member, to their own tokens, in the `WHERE` rather than by dropping rows
 * afterwards.
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
  /**
   * Who holds it. The email is filled in only when the caller supplied a
   * directory — an admin listing their organization's tokens — so a member's
   * own list never carries anyone else's address.
   */
  assignedTo: { id: string, email?: string }
  /** Wire shape, identical to what create and patch accept. */
  scope: ScopeInput
  /** Appended to every message this token sends. Absent = off. */
  send_disclaimer?: string
  /**
   * How its secret reaches the client. `static` is shown once at mint;
   * `oauth` is never shown at all — its holder signs in from the client.
   */
  authMethod: 'static' | 'oauth'
  /**
   * An OAuth grant's state. `claimed` false is "awaiting sign-in": it
   * authenticates nothing until its holder signs in. `client` is the name the
   * application registered itself under — its own choice, not verified.
   */
  oauth?: { claimed: boolean, client?: string, claimedAt?: string }
}

export function toPublicToken(
  token: AppMcpToken & { oauth_client_name?: string },
  emails?: Map<string, string>,
): PublicToken {
  const expired = Boolean(token.expires_at) && new Date(token.expires_at!).getTime() <= Date.now()
  return {
    id: token.id,
    label: token.label || 'Untitled token',
    created: token.created,
    last_used_at: token.last_used_at || undefined,
    expires_at: token.expires_at || undefined,
    revoked: Boolean(token.revoked),
    expired,
    assignedTo: { id: token.assigned_to, email: emails?.get(token.assigned_to) },
    scope: scopeToInput(scopeFromRecord(token)),
    send_disclaimer: token.send_disclaimer || undefined,
    authMethod: token.auth_method === 'oauth' ? 'oauth' : 'static',
    oauth: token.auth_method === 'oauth'
      ? {
          claimed: Boolean(token.claimed_at),
          client: token.claimed_at ? token.oauth_client_name : undefined,
          claimedAt: token.claimed_at,
        }
      : undefined,
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
  options: { assignedTo?: string, emails?: Map<string, string> } = {},
): Promise<PublicToken[]> {
  const sql = await appDb()

  const rows = await sql<(AppMcpToken & { oauth_client_name?: string })[]>`
    SELECT t.*, c.name AS oauth_client_name
    FROM app.mcp_tokens t
    LEFT JOIN app.oauth_clients c ON c.id = t.oauth_client
    WHERE t.instance = ${instanceId}
      ${options.assignedTo ? sql`AND t.assigned_to = ${options.assignedTo}` : sql``}
    ORDER BY t.created DESC
  `
  return rows.map(row => toPublicToken(row, options.emails))
}

/** Expiry presets offered by the UI. `never` leaves `expires_at` NULL. */
export type ExpiryPreset = '30d' | '90d' | '1y' | 'never'

function expiryFromPreset(preset: ExpiryPreset): string | null {
  if (preset === 'never') return null
  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 365
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * The scope columns.
 *
 * Always writes all six, so a scope edit can never leave one axis as whatever
 * it happened to be before. The lists are `jsonb` and go in as plain arrays:
 * postgres.js serialises a parameter by the column type the server describes,
 * so a pre-stringified value would be stored as a JSON *string*.
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
  /** Appended to every message the token sends. Null or absent = off. */
  sendDisclaimer?: string | null
  /**
   * An OAuth grant: minted with no secret ("awaiting sign-in"), claimed later
   * by its holder signing in from an MCP client. See server/utils/oauth.ts.
   */
  oauth?: boolean
}

export async function createToken(input: CreateTokenInput, db?: Db): Promise<{ token?: string, record: PublicToken }> {
  const minted = input.oauth ? undefined : mintMcpToken()
  const sql = db ?? await appDb()
  const [record] = await sql<AppMcpToken[]>`
    INSERT INTO app.mcp_tokens ${sql({
      assigned_to: input.assignedTo,
      created_by: input.createdBy,
      instance: input.instanceId,
      token_hash: minted?.hash ?? null,
      auth_method: input.oauth ? 'oauth' : 'static',
      label: input.label.trim() || 'Untitled token',
      expires_at: expiryFromPreset(input.preset),
      revoked: false,
      send_disclaimer: input.sendDisclaimer ?? null,
      ...scopeFields(input.scope),
    })}
    RETURNING *
  `

  return { token: minted?.token, record: toPublicToken(record!) }
}

/**
 * Mint a token on a connection the caller has already authorized as a manager
 * of — the whole of minting, shared by the token dialog and the OAuth consent
 * page's shortcut so the two cannot drift.
 *
 * The holder must already reach the connection: a token issued to someone who
 * does not is born dead (renders "Active", answers 401, nothing logged). The
 * plan limit and the insert share one transaction under the organization row
 * lock `assertCanAdd` takes, so two racing mints at the limit cannot both land.
 */
export async function issueConnectorToken(input: {
  actor: Actor
  instance: AppInstance
  assignedTo: string
  label: string
  preset: ExpiryPreset
  scope: McpScope
  sendDisclaimer?: string | null
  oauth?: boolean
}): Promise<{ token?: string, record: PublicToken }> {
  const { actor, instance, assignedTo } = input

  if (assignedTo !== actor.user.id) {
    const member = await requireOrgMember(actor.org.id, assignedTo)
    const reaches = member.role === 'admin'
      || (await listInstanceAssignees(instance.id)).includes(assignedTo)

    if (!reaches) {
      throw createError({
        statusCode: 422,
        statusMessage: `${member.email} cannot reach this connection, so a token issued to them `
          + 'would not work. Assign the connection to them first.',
      })
    }
  }

  const sql = await appDb()
  return await sql.begin(async (tx) => {
    await assertCanAdd(tx, actor.org.id, 'token')
    const minted = await createToken({
      instanceId: instance.id,
      assignedTo,
      createdBy: actor.user.id,
      label: input.label,
      preset: input.preset,
      scope: input.scope,
      sendDisclaimer: input.sendDisclaimer,
      oauth: input.oauth,
    }, tx)
    await recordHostedEvent(tx, {
      type: 'token.created',
      org: actor.org.id,
      userId: assignedTo,
      payload: { id: minted.record.id, connection: instance.id, kind: instance.kind, auth: input.oauth ? 'oauth' : 'static' },
    })
    return minted
  })
}

/**
 * The scope a token starts with when nobody picked one — the consent page's
 * shortcut. Same rule as the token dialog's `initialScope()`: a messaging token
 * starts open, a database or mailbox token with its read tools only, since a
 * token that turns out to need writes is one edit away and one that did not may
 * already have made some.
 */
export function defaultScopeFor(kind: InstanceKind): McpScope {
  switch (kind) {
    case 'whatsapp':
    case 'telegram':
      return OPEN_SCOPE
    case 'postgres':
    case 'imap':
      return { ...OPEN_SCOPE, allTools: false, toolNames: readOnlyToolsFor(kind) }
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * Change a token's scope without reissuing it.
 *
 * The connector already configured in Claude keeps working; only what it may
 * reach changes, from the next request onward. Scope is read fresh on every MCP
 * request, so there is nothing to invalidate.
 */
/**
 * Issue a new secret for an existing token, leaving everything else alone.
 *
 * This is the one write a member may make to their own token, and it exists so
 * that responding to a leaked credential never queues behind someone else's
 * approval. Scope is deliberately untouched — rotating changes *what the secret
 * is*, not *what it reaches* — which is what makes it safe to hand to someone
 * who may not edit scope.
 *
 * `expires_at` is untouched too, so a rotated token does not quietly gain
 * another 90 days; that is why an expired one is refused rather than rotated
 * into a new secret that is already dead on arrival. `last_used_at` stays as
 * well: it is the row's audit trail, not the secret's.
 *
 * The plaintext is returned here and nowhere else, exactly as at creation.
 */
export async function rotateToken(token: AppMcpToken): Promise<{ token?: string, record: PublicToken }> {
  if (token.revoked) {
    throw createError({
      statusCode: 422,
      statusMessage: 'This token has been revoked. Ask an admin for a new one instead.',
    })
  }
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
    throw createError({
      statusCode: 422,
      statusMessage: 'This token has expired, so a new secret for it would not work. '
        + 'Ask an admin for a new one instead.',
    })
  }

  // An OAuth grant's secret is never shown, so "a new secret" means signing out
  // whichever client holds it: its holder signs in again to get a new one.
  if (token.auth_method === 'oauth') {
    await clearGrantSecrets(await appDb(), token.id)
    const record = await getRow<AppMcpToken>('mcp_tokens', token.id)
    return { record: toPublicToken(record!) }
  }

  const { token: plaintext, hash } = mintMcpToken()
  const record = await updateRow<AppMcpToken>('mcp_tokens', token.id, { token_hash: hash })
  return { token: plaintext, record: toPublicToken(record) }
}

export async function updateTokenScope(
  token: AppMcpToken,
  scope: McpScope,
  sendDisclaimer?: string | null,
  label?: string,
): Promise<PublicToken> {
  // `undefined` leaves the disclaimer and the name as they are; a `null`
  // disclaimer turns it off.
  const record = await updateRow<AppMcpToken>('mcp_tokens', token.id, {
    ...scopeFields(scope),
    ...(sendDisclaimer === undefined ? {} : { send_disclaimer: sendDisclaimer }),
    ...(label === undefined ? {} : { label }),
  })
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
  await updateRow('mcp_tokens', token.id, { revoked: true })
}

/**
 * Revoke every live token one member holds, optionally narrowed to one
 * connection.
 *
 * Used wherever an action would otherwise leave a token that still reads
 * "Active" in the UI and answers 401 on the wire: removing a member, demoting
 * an admin, unassigning a connection. Returns how many were revoked so the
 * caller can say so. Pass the caller's transaction where the revoke must stand
 * or fall with the change that caused it.
 */
export async function revokeTokensFor(
  userId: string,
  options: { instanceId?: string } = {},
  db?: Db,
): Promise<number> {
  const sql = db ?? await appDb()
  const result = await sql`
    UPDATE app.mcp_tokens SET revoked = true, updated = now()
    WHERE assigned_to = ${userId} AND NOT revoked
      ${options.instanceId ? sql`AND instance = ${options.instanceId}` : sql``}
  `
  return result.count
}

/** The read tools of one kind, from the toolkit's own registry (as `mcp-tools.get.ts` reads it). */
function readOnlyToolsFor(kind: InstanceKind): string[] {
  return tools
    .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
    .filter(tool => toolServesKind(tool.name!, kind) && tool.annotations?.readOnlyHint === true)
    .map(tool => tool.name!)
}
