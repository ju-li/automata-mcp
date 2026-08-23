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
  profilePicUrl?: string
}

export interface TokenScope {
  all_tools: boolean
  tool_names: string[]
  all_chats: boolean
  chat_jids: string[]
}

export function openScope(): TokenScope {
  return { all_tools: true, tool_names: [], all_chats: true, chat_jids: [] }
}

/** One-line summary for the tokens table. */
export function describeScope(scope: TokenScope): string {
  if (scope.all_tools && scope.all_chats) return 'Full access'

  const parts: string[] = []
  parts.push(scope.all_chats ? 'All chats' : plural(scope.chat_jids.length, 'chat'))
  parts.push(scope.all_tools ? 'all actions' : plural(scope.tool_names.length, 'action'))
  return parts.join(' · ')
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
