import type { H3Event } from 'h3'
import type { AppInstance } from './pocketbase'
import type { McpAuth } from './mcp-auth'

/**
 * Connector token scope: which chats a token may touch, and which tools it may
 * call. This module is the only place scope is interpreted.
 *
 * Both axes default open. A token with `allChats` and `allTools` behaves exactly
 * as tokens did before scoping existed.
 *
 * Enforcement happens in two different places, because they have to:
 *
 *   tools  `enabled(event)` on each tool definition. The toolkit evaluates it
 *          before building the request's MCP server, so a disallowed tool is
 *          never registered — `tools/call` fails just like `tools/list` omits
 *          it. This is real enforcement, not hiding.
 *   chats  inside handlers. `enabled` cannot see tool arguments, and the chat a
 *          call targets is an argument.
 */

export interface McpScope {
  allChats: boolean
  chatJids: string[]
  allTools: boolean
  toolNames: string[]
}

export const OPEN_SCOPE: McpScope = {
  allChats: true,
  chatJids: [],
  allTools: true,
  toolNames: [],
}

/**
 * Read scope off a PocketBase token record.
 *
 * `!== false` rather than `=== true` so a genuinely missing key (a partial fetch,
 * a hand-written record) reads as open rather than as a token with no access.
 *
 * That is not a safety net for writes, though: **PocketBase materialises an unset
 * boolean field as `false`**, not as absent. A write path that forgets to set
 * these produces a token that can do nothing at all. Every write must be
 * explicit — see `createToken` in tokens.ts.
 */
export function scopeFromRecord(record: {
  all_chats?: boolean
  chat_jids?: unknown
  all_tools?: boolean
  tool_names?: unknown
}): McpScope {
  return {
    allChats: record.all_chats !== false,
    chatJids: toStringArray(record.chat_jids),
    allTools: record.all_tools !== false,
    toolNames: toStringArray(record.tool_names),
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

// ── tools ──────────────────────────────────────────────────────────────────

/**
 * For the `enabled` guard on a tool definition.
 *
 * Fails closed: no auth context means no tools. That state is unreachable while
 * server/mcp/index.ts returns 401 before any tool is resolved, but if that ever
 * changes, an empty toolset is the safe outcome.
 */
export function isToolAllowed(event: H3Event, toolName: string): boolean {
  const auth = event.context.mcpAuth as McpAuth | undefined
  if (!auth) return false

  const scope = auth.scope
  if (scope.allTools) return true
  return scope.toolNames.includes(toolName)
}

// ── chats ──────────────────────────────────────────────────────────────────

export function isChatAllowed(scope: McpScope, jid: string): boolean {
  if (scope.allChats) return true
  return scope.chatJids.includes(jid)
}

/**
 * Refuse loudly, naming the chat.
 *
 * A model that gets a clear refusal can tell the user what happened. One that
 * gets an empty result assumes the chat is empty and says so, which is worse
 * than an error.
 */
export function assertChatAllowed(scope: McpScope, jid: string): void {
  if (isChatAllowed(scope, jid)) return
  throw createError({
    statusCode: 403,
    message: `This connector token is not scoped to ${jid}. Ask the account owner to add this chat to the token's allowed list.`,
  })
}

/**
 * Filter a chat listing down to scope.
 *
 * Silent, unlike the assertions above — filtering is the honest answer to "what
 * can I see". Refusing the whole listing because one row is out of scope would
 * make a scoped token useless for browsing.
 */
export function filterChatsToScope<T extends { jid: string }>(scope: McpScope, chats: T[]): T[] {
  if (scope.allChats) return chats
  const allowed = new Set(scope.chatJids)
  return chats.filter(chat => allowed.has(chat.jid))
}

/**
 * Turn a phone number into the JID Evolution would use for it.
 *
 * **Never normalise JIDs locally.** Evolution's `createJid` carries
 * country-specific rules — Brazil's ninth digit, Mexico and Argentina prefixes —
 * so a hand-rolled comparison would let a scoped token reach a chat it was not
 * granted, or refuse one it was. Asking Evolution is the only way to be sure the
 * two sides agree.
 *
 * Requires a connected instance: the lookup goes through Baileys. Callers must
 * treat a failure as "cannot verify", never as "allowed".
 */
export async function resolveNumberToJid(
  instance: AppInstance,
  number: string,
): Promise<{ jid: string, exists: boolean, name?: string }> {
  const evolution = evolutionClientForInstance(instance)

  const results = await evolution<Array<{ jid: string, exists: boolean, number: string, name?: string }>>(
    `/chat/whatsappNumbers/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { numbers: [number] } },
  )

  const match = Array.isArray(results) ? results[0] : undefined
  if (!match?.jid) {
    throw createError({
      statusCode: 422,
      message: `Could not resolve "${number}" to a WhatsApp account.`,
    })
  }

  return { jid: match.jid, exists: Boolean(match.exists), name: match.name }
}

/**
 * Scope check for a send, which addresses a chat by phone number rather than JID.
 *
 * Resolves through Evolution and compares exact JIDs. **Fails closed** — if the
 * lookup throws (instance offline, Evolution unreachable) the send is refused,
 * because an unverifiable recipient is exactly the case scope exists to stop.
 */
export async function assertNumberAllowed(
  instance: AppInstance,
  scope: McpScope,
  number: string,
): Promise<string> {
  if (scope.allChats) {
    // Nothing to check, so do not pay for the round trip.
    return number
  }

  let resolved: { jid: string }
  try {
    resolved = await resolveNumberToJid(instance, number)
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 422) throw error
    throw createError({
      statusCode: 503,
      message: 'Could not verify the recipient against this token\'s allowed chats, so the message was not sent. The WhatsApp account may be disconnected.',
      cause: error,
    })
  }

  assertChatAllowed(scope, resolved.jid)
  return resolved.jid
}
