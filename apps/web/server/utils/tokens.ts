import type { AppMcpToken } from './pocketbase'

/**
 * MCP token CRUD, always scoped to one instance and one owner.
 *
 * Every query filters on the owning user as well as the id it was handed, so a
 * guessed id from another account resolves to nothing rather than to someone
 * else's token. Filters use `pb.filter()` bindings — the admin client must
 * never receive a filter string built by concatenating user input.
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
  }
}

export async function listTokens(instanceId: string): Promise<PublicToken[]> {
  const pb = await pocketbaseAdmin()
  const rows = await pb.collection('mcp_tokens').getFullList<AppMcpToken>({
    filter: pb.filter('instance = {:iid}', { iid: instanceId }),
    sort: '-created',
  })
  return rows.map(toPublicToken)
}

/** Expiry presets offered by the UI. `never` leaves `expires_at` empty. */
export type ExpiryPreset = '30d' | '90d' | '1y' | 'never'

export function expiryFromPreset(preset: ExpiryPreset): string {
  if (preset === 'never') return ''
  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 365
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Mint a token. The plaintext is returned to the caller once, here, and is not
 * recoverable afterwards — only its SHA-256 hash is stored.
 */
export async function createToken(
  userId: string,
  instanceId: string,
  label: string,
  preset: ExpiryPreset,
): Promise<{ token: string, record: PublicToken }> {
  const { token, hash } = mintMcpToken()
  const pb = await pocketbaseAdmin()

  const record = await pb.collection('mcp_tokens').create<AppMcpToken>({
    user: userId,
    instance: instanceId,
    token_hash: hash,
    label: label.trim() || 'Untitled token',
    expires_at: expiryFromPreset(preset),
    revoked: false,
  })

  return { token, record: toPublicToken(record) }
}

/**
 * Revoke rather than delete: access stops immediately, and the row survives so
 * `last_used_at` stays available as an audit trail.
 *
 * Returns false when the token does not exist or is not this user's — the
 * caller answers 404 either way, so ownership is not observable.
 */
export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const pb = await pocketbaseAdmin()

  let record: AppMcpToken
  try {
    record = await pb.collection('mcp_tokens').getFirstListItem<AppMcpToken>(
      pb.filter('id = {:id} && user = {:uid}', { id: tokenId, uid: userId }),
    )
  } catch (error) {
    if (isPocketBaseNotFound(error)) return false
    throw error
  }

  await pb.collection('mcp_tokens').update(record.id, { revoked: true })
  return true
}
