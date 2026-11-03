import { assertNever } from '#shared/connection'
import { tools } from '#nuxt-mcp-toolkit/tools.mjs'
import type { McpAuth } from './mcp-auth'
import type { InstanceKind } from './mcp-scope'

/**
 * The toolkit's tool list item, taken from `defineMcpHandler` itself rather
 * than imported from a deep path outside the package's `exports` map — the same
 * reasoning as `ToolDefinition` in mcp-kind-tool.ts. The generated
 * `#nuxt-mcp-toolkit/tools.mjs` declaration is narrower (no `handler`), so the
 * registry is read through this type.
 */
type HandlerTools = NonNullable<Parameters<typeof defineMcpHandler>[0]['tools']>
export type ToolDefinition = Extract<HandlerTools, unknown[]>[number]

/** Every discovered tool, as the handler option types it. */
export const allTools = tools as unknown as ToolDefinition[]

/** Between a connection's handle and the tool's own name: `orders_db__run-query`. */
export const SESSION_TOOL_SEPARATOR = '__'

/**
 * The tools an OAuth sign-in sees: every tool each of its connections may
 * call, renamed `<handle>__<tool>`.
 *
 * **Why renamed copies rather than a `connection` argument.** One sign-in can
 * cover two WhatsApp numbers, which would otherwise both expose
 * `read-messages`. A connection argument would bring back what "tools take no
 * connection argument" exists to prevent — every call one parameter away from
 * the wrong account — and a per-tool permission in the client could no longer
 * tell the two apart. A renamed copy still reaches exactly one connection,
 * fixed when the list is built, and says which in its name.
 *
 * **How a copy reaches its connection.** Every handler reads its connection
 * through `currentMcpAuth()` (via `useMcpAuth`, `useEvolutionClient`,
 * `useTelegramBridge`, `pgFor(useMcpAuth().instance)`), so the copy runs the
 * original handler inside `mcpAuthContext.run(connection, …)` and the handler
 * itself is unchanged. Scope checks inside handlers (`assertChatAllowed`, the
 * Postgres plan walk) read the same context and so see this connection's scope.
 *
 * Built per request, after authentication: the toolkit resolves a handler's
 * `tools` function in `resolveDynamicDefinitions`, inside its handler and after
 * the auth middleware's `next()` (0.19.0 `utils.js`), unlike `instructions`,
 * which it reads before auth. **Toolkit bump = re-check that ordering.**
 */
export function sessionToolsFor(connections: McpAuth[]): ToolDefinition[] {
  const out: ToolDefinition[] = []
  for (const auth of connections) {
    const { label, kind } = describeConnection(auth)
    const handle = auth.instance.handle
    for (const definition of allTools) {
      const name = definition.name
      if (typeof name !== 'string' || name.length === 0) continue
      // The same three conditions the static `enabled` gate applies.
      if (!toolServesKind(name, auth.kind)) continue
      if (!authAllowsTool(auth, name, auth.kind)) continue
      if (!toolAvailable(name)) continue

      const original = definition.handler as (...args: unknown[]) => unknown
      out.push({
        ...definition,
        name: `${handle}${SESSION_TOOL_SEPARATOR}${name}`,
        title: `${label}: ${definition.title || name}`,
        description: `On "${label}" (${kind}). ${definition.description ?? ''}`.trim(),
        // Decided here, per connection; the original reads `event.context.mcpAuth`,
        // which a session request does not set.
        enabled: undefined,
        handler: ((...args: unknown[]) => mcpAuthContext.run(auth, () => original(...args))) as ToolDefinition['handler'],
      } as ToolDefinition)
    }
  }
  return out
}

/** How a connection is named to the model, in tool titles and the instructions. */
export function describeConnection(auth: McpAuth): { label: string, kind: string, handle: string } {
  return { label: toPublicInstance(auth.instance).label, kind: kindNoun(auth.kind), handle: auth.instance.handle }
}

function kindNoun(kind: InstanceKind): string {
  switch (kind) {
    case 'whatsapp': return 'WhatsApp account'
    case 'telegram': return 'Telegram account'
    case 'postgres': return 'PostgreSQL database'
    case 'imap': return 'email mailbox'
    default: return assertNever(kind, 'connection kind')
  }
}
