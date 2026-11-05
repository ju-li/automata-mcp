/**
 * The MCP clients a connector token was used from, as the token list receives
 * them — mirrors `PublicTokenClient` in server/utils/mcp-clients.ts.
 *
 * Every string here is what the client called itself: render it as text (Vue's
 * interpolation escapes it), never as HTML, and never present it as proof of
 * who is on the other end.
 */
export interface TokenClient {
  name: string
  version: string
  protocolVersion?: string
  userAgent?: string
  firstSeen: string
  /** The last session started, not the last tool call. */
  lastSeen: string
  sessions: number
  /** Turned up late on a token that already had other clients. A hint only. */
  newClient: boolean
}

/** How one client reads in a sentence: "claude-ai 0.1.0", or "Unnamed client". */
export function clientLabel(client: Pick<TokenClient, 'name' | 'version'>): string {
  const name = client.name || 'Unnamed client'
  return client.version ? `${name} ${client.version}` : name
}

/**
 * One entry per client name, at the version it last started a session with —
 * a version bump is the same client, and listing both would read as two.
 * Expects the server's order, newest session first.
 */
export function distinctClients(clients: TokenClient[]): TokenClient[] {
  const seen = new Set<string>()
  return clients.filter((client) => {
    if (seen.has(client.name)) return false
    seen.add(client.name)
    return true
  })
}
