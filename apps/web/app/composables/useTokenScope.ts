import { assertNever } from '#shared/connection'

export interface McpToolInfo {
  name: string
  title: string
  description: string
  readOnly: boolean
  /** Not covered by "All actions": granted only when ticked by name (`optIn` on the server's `defineKindTool`). */
  optIn?: boolean
}

export interface ScopedChat {
  jid: string
  /**
   * WhatsApp only: every JID this row stands for, when more than one — a person
   * stored under both a LID and a phone number. Picking the row picks all.
   */
  jids?: string[]
  name: string
  isGroup?: boolean
  /** Bare phone number of a 1:1 WhatsApp chat. Groups do not have one. */
  number?: string
  /**
   * WhatsApp LID chats only: the phone number behind the alias, when WhatsApp
   * revealed it on a live message. Absent means unknown, not "has none". The
   * chat is still the LID — scope and replies follow `jid`, not this.
   */
  phoneNumber?: string
  /** Telegram only: the chat's public @username, without the @. */
  username?: string
  /** IMAP only: emails synced in this folder. */
  messages?: number
  /** IMAP only: false for a folder that exists but is not synced (Junk, Trash, All Mail). */
  synced?: boolean
  /** Members in a group. Absent when the group lookup was skipped as unnecessary. */
  participantCount?: number
  profilePicUrl?: string
  /** Evolution's Chat row mtime, ISO 8601. A fallback when lastMessageAt is absent. */
  updatedAt?: string
  /** When the last message was sent, ISO 8601, when Evolution's row carries one. */
  lastMessageAt?: string
  /**
   * Telegram only: why older history stops short of the chat's start — `count`
   * (the per-chat message limit, which a manager can raise), `days` (the day
   * limit), `skipped`, `inaccessible`. Absent while still fetching, or complete.
   */
  historyStopped?: 'count' | 'days' | 'skipped' | 'inaccessible'
  /** Telegram only: the oldest message synced, when `historyStopped` is set. */
  historyFrom?: string
}

/** One reachable Postgres relation, `schema.table`, case-sensitive. */
export interface ScopedTable {
  qname: string
  schema: string
  name: string
  kind: string
  comment?: string
  estimatedRows?: number | null
}

export interface TokenScope {
  all_tools: boolean
  tool_names: string[]
  all_chats: boolean
  chat_jids: string[]
  all_tables: boolean
  table_names: string[]
}

export function openScope(): TokenScope {
  return {
    all_tools: true,
    tool_names: [],
    all_chats: true,
    chat_jids: [],
    all_tables: true,
    table_names: [],
  }
}

/**
 * Initial scope for a new token on a Postgres or mailbox connection: every
 * read tool, no write tool.
 *
 * Read-only is the default because the cost of the two mistakes is not
 * symmetric — a token that turns out to need writes is one edit away, and a
 * token that turns out not to have needed them may already have made some.
 * The caller passes the read tools because only the server knows what they are.
 */
export function readOnlyScope(readToolNames: string[]): TokenScope {
  return {
    all_tools: false,
    tool_names: [...readToolNames],
    all_chats: true,
    chat_jids: [],
    all_tables: true,
    table_names: [],
  }
}

/**
 * One-line summary for the tokens table.
 *
 * Only the axis that applies to this connection's kind is mentioned: a Postgres
 * token leaves `all_chats` at its default `true`, and reporting "All chats" for
 * a database would be noise at best.
 *
 * `tools` is the connection's tool catalogue, for its opt-in actions: "All
 * actions" leaves those out, so a token without them is not "Full access".
 * Without it, opt-in names held under "All actions" are counted, unnamed.
 */
export function describeScope(scope: TokenScope, kind: InstanceKind, tools?: readonly McpToolInfo[]): string {
  let dataOpen: boolean
  let data: string
  switch (kind) {
    case 'postgres':
      dataOpen = scope.all_tables
      data = scope.all_tables ? 'All tables' : plural(scope.table_names.length, 'table')
      break
    case 'whatsapp':
    case 'telegram':
      dataOpen = scope.all_chats
      data = scope.all_chats ? 'All chats' : plural(scope.chat_jids.length, 'chat')
      break
    // Folders ride the chat axis (`chat_jids` holds paths on a mail token).
    case 'imap':
      dataOpen = scope.all_chats
      data = scope.all_chats ? 'All folders' : plural(scope.chat_jids.length, 'folder')
      break
    default:
      return assertNever(kind, 'connection kind')
  }

  if (!scope.all_tools) return [data, plural(scope.tool_names.length, 'action')].join(' · ')

  // Under "All actions" the names held are opt-in actions (`scopeForSubmit`).
  const optIn = tools?.filter(tool => tool.optIn)
  const granted = optIn ? optIn.filter(tool => scope.tool_names.includes(tool.name)) : []
  const withheld = optIn ? optIn.length - granted.length : 0
  if (dataOpen && optIn && withheld === 0) return 'Full access'
  const actions = !optIn
    ? (scope.tool_names.length ? `all actions + ${plural(scope.tool_names.length, 'opt-in action')}` : 'all actions')
    : granted.length
      ? `all actions + ${granted.map(tool => tool.title).join(', ')}`
      : withheld ? 'all actions except opt-in ones' : 'all actions'
  return [data, actions].join(' · ')
}

/**
 * The scope as it is sent to the server. Under "All actions" only opt-in names
 * are kept: they are the only ones that grant anything there, and the ordinary
 * names left over from "Only selected actions" would otherwise be stored and
 * counted. Without the catalogue it is sent as it is; the server's gate decides
 * either way.
 */
export function scopeForSubmit<T extends TokenScope>(scope: T, tools?: readonly McpToolInfo[]): T {
  if (!scope.all_tools || !tools) return scope
  const optIn = new Set(tools.filter(tool => tool.optIn).map(tool => tool.name))
  return { ...scope, tool_names: scope.tool_names.filter(name => optIn.has(name)) }
}

/** What the disclaimer field holds when an admin turns it on. Editable from there. */
export const DEFAULT_SEND_DISCLAIMER = 'Sent using Automata'

/**
 * The tools that send messages on this kind of connection, if it has any.
 *
 * Named rather than inferred from "any write tool": the disclaimer is applied
 * inside these handlers specifically, so a future write tool is not covered by
 * it until it applies the disclaimer itself and is named here.
 */
function sendToolsOf(kind: InstanceKind): readonly string[] {
  switch (kind) {
    case 'whatsapp':
      return ['send-text-message', 'send-whatsapp-image']
    case 'telegram':
      return ['send-telegram-message', 'send-telegram-image']
    case 'postgres':
    case 'imap':
      return []
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * Whether a token with this scope may send messages from the account. A send
 * tool marked opt-in in `catalogue` is granted by name only, "All actions" or not.
 */
export function allowsSending(scope: TokenScope, kind: InstanceKind, catalogue?: readonly McpToolInfo[]): boolean {
  const tools = sendToolsOf(kind)
  if (tools.length === 0) return false
  const optIn = new Set((catalogue ?? []).filter(tool => tool.optIn).map(tool => tool.name))
  return tools.some(tool => scope.tool_names.includes(tool) || (scope.all_tools && !optIn.has(tool)))
}

/**
 * The `send_disclaimer` to submit. A token that cannot send stores none, so
 * turning sending off and back on later does not revive a disclaimer nobody
 * could see while it was hidden; a blank field is off, not an empty line.
 */
export function disclaimerToSubmit(
  scope: TokenScope,
  kind: InstanceKind,
  disclaimer: string | null,
  catalogue?: readonly McpToolInfo[],
): string | null {
  if (!allowsSending(scope, kind, catalogue)) return null
  return disclaimer?.trim() || null
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
