import { z } from 'zod'
import type { McpScope } from './mcp-scope'

/**
 * One schema for both minting and editing, so the two can never disagree about
 * what a valid scope is.
 *
 * An empty allowlist with its "all" flag off would create a token that can do
 * nothing while looking configured. Refuse it rather than let someone build one
 * by accident and spend an afternoon wondering why Claude sees no tools.
 */
export const scopeSchema = z.object({
  all_tools: z.boolean().default(true),
  tool_names: z.array(z.string().min(1)).default([]),
  all_chats: z.boolean().default(true),
  chat_jids: z.array(z.string().min(1)).default([]),
})
  .refine(v => v.all_tools || v.tool_names.length > 0, {
    message: 'Select at least one action, or allow all actions',
    path: ['tool_names'],
  })
  .refine(v => v.all_chats || v.chat_jids.length > 0, {
    message: 'Select at least one chat, or allow all chats',
    path: ['chat_jids'],
  })

export type ScopeInput = z.infer<typeof scopeSchema>

export function scopeFromInput(input: ScopeInput): McpScope {
  return {
    allTools: input.all_tools,
    toolNames: input.all_tools ? [] : dedupe(input.tool_names),
    allChats: input.all_chats,
    chatJids: input.all_chats ? [] : dedupe(input.chat_jids),
  }
}

/**
 * The inverse of `scopeFromInput`.
 *
 * Scope is returned in the same shape it is submitted, so a client can read a
 * token, hand the scope straight back to a PATCH, and get what it expected. The
 * internal `McpScope` is camelCase; the wire format is not.
 */
export function scopeToInput(scope: McpScope): ScopeInput {
  return {
    all_tools: scope.allTools,
    tool_names: scope.toolNames,
    all_chats: scope.allChats,
    chat_jids: scope.chatJids,
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
