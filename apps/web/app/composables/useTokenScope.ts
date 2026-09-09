export interface McpToolInfo {
  name: string
  title: string
  description: string
  readOnly: boolean
}

export interface ScopedChat {
  jid: string
  name: string
  isGroup?: boolean
  /** Bare phone number of a 1:1 chat. Groups do not have one. */
  number?: string
  /** Members in a group. Absent when the group lookup was skipped as unnecessary. */
  participantCount?: number
  profilePicUrl?: string
  /** Evolution's Chat row mtime, ISO 8601. A fallback when lastMessageAt is absent. */
  updatedAt?: string
  /** When the last message was sent, ISO 8601, when Evolution's row carries one. */
  lastMessageAt?: string
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
 * Initial scope for a new token on a Postgres connection: every read tool, no
 * write tool.
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
 */
export function describeScope(scope: TokenScope, kind: 'whatsapp' | 'postgres' = 'whatsapp'): string {
  const dataOpen = kind === 'postgres' ? scope.all_tables : scope.all_chats
  if (scope.all_tools && dataOpen) return 'Full access'

  const parts: string[] = []
  if (kind === 'postgres') {
    parts.push(scope.all_tables ? 'All tables' : plural(scope.table_names.length, 'table'))
  }
  else {
    parts.push(scope.all_chats ? 'All chats' : plural(scope.chat_jids.length, 'chat'))
  }
  parts.push(scope.all_tools ? 'all actions' : plural(scope.tool_names.length, 'action'))
  return parts.join(' · ')
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
