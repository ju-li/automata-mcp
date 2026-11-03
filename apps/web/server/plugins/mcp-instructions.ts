import { assertNever } from '#shared/connection'
import type { McpAuth, McpCredential } from '../utils/mcp-auth'
import type { InstanceKind } from '../utils/mcp-scope'
import { IMAP_INSTRUCTIONS, POSTGRES_INSTRUCTIONS, TELEGRAM_INSTRUCTIONS, WHATSAPP_INSTRUCTIONS } from '../utils/mcp-instructions'

/**
 * Give each connection kind its own MCP server instructions.
 *
 * **Why a Nitro hook and not a getter on the handler.** `mcp.instructions` is
 * typed as a plain string, and the toolkit resolves the whole handler config in
 * the *first* statement of its request handler — `resolveConfig(config, event)`
 * at dist/runtime/server/mcp/utils.js:195 — and only reaches our auth middleware
 * at :208. A getter on the object passed to `defineMcpHandler` therefore fires
 * before `event.context.mcpAuth` is set and would read as unauthenticated on
 * every request, silently serving one kind's prose to the other.
 *
 * `mcp:config:resolved` (:203) fires inside `next()`, after the middleware, on
 * the same mutable object that is handed to `createMcpServer` at :205 and
 * reaches `new McpServer(..., { instructions })` at :54-60. That is the only
 * seam in 0.19.0 where the caller is known and the value is still writable.
 *
 * This is a toolkit internal, like modules/mcp-token-route.ts. **Bumping
 * @nuxtjs/mcp-toolkit means re-checking that ordering.** If the hook stops
 * firing, the fallback in nuxt.config takes over and the failure is a Postgres
 * connector receiving WhatsApp instructions — wrong, but not fatal. The toolkit
 * catches a throwing hook and logs it (`callMcpHook`, utils.js:166-172), so a
 * break here is loud in the logs rather than silent.
 */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const session = event.context.mcpSession as Extract<McpCredential, { type: 'session' }> | undefined
    if (session) {
      config.instructions = sessionInstructions(session.connections)
      return
    }

    const auth = event.context.mcpAuth as McpAuth | undefined
    // No auth means the request never got past the middleware, so there is no
    // connection to describe. Leave the configured fallback in place.
    if (!auth) return
    config.instructions = instructionsFor(auth.kind)
  })
})

function instructionsFor(kind: InstanceKind): string {
  switch (kind) {
    case 'postgres':
      return POSTGRES_INSTRUCTIONS
    case 'whatsapp':
      return WHATSAPP_INSTRUCTIONS
    case 'telegram':
      return TELEGRAM_INSTRUCTIONS
    case 'imap':
      return IMAP_INSTRUCTIONS
    default:
      return assertNever(kind, 'MCP auth kind')
  }
}

/**
 * An OAuth sign-in covers several connections: name each with its handle, say
 * how tool names are formed, then each kind's own text once. The per-kind texts
 * speak of `read-messages`, `run-query` and so on; the opening paragraph is what
 * maps those to the prefixed names this server actually lists. Each kind's text
 * also says "bound to exactly one account" — true per tool here, and the
 * opening says so, so the two do not read as a contradiction.
 */
function sessionInstructions(connections: McpAuth[]): string {
  const lines = connections.map((auth) => {
    const { label, kind, handle } = describeConnection(auth)
    return `- \`${handle}\`: ${label} (${kind})`
  })
  const kinds = [...new Set(connections.map(c => c.kind))]
  return [
    `This server covers ${connections.length === 1 ? 'one connection' : `${connections.length} connections`}, chosen by the user when they signed in:`,
    ...lines,
    '',
    `Every tool name starts with its connection's handle and \`${SESSION_TOOL_SEPARATOR}\` — \`${connections[0]!.instance.handle}${SESSION_TOOL_SEPARATOR}…\` acts on that connection and no other. The guidance below names tools without that prefix and describes each kind once; "this server is bound to one account" holds for each tool, not for the server as a whole. When the user's request could mean more than one connection, ask which.`,
    '',
    ...kinds.map(kind => instructionsFor(kind)),
  ].join('\n')
}
