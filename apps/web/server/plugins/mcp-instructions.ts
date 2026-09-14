import { assertNever } from '#shared/connection'
import type { McpAuth } from '../utils/mcp-auth'
import { POSTGRES_INSTRUCTIONS, TELEGRAM_INSTRUCTIONS, WHATSAPP_INSTRUCTIONS } from '../utils/mcp-instructions'

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
    const auth = event.context.mcpAuth as McpAuth | undefined
    // No auth means the request never got past the middleware, so there is no
    // connection to describe. Leave the configured fallback in place.
    if (!auth) return

    switch (auth.kind) {
      case 'postgres':
        config.instructions = POSTGRES_INSTRUCTIONS
        break
      case 'whatsapp':
        config.instructions = WHATSAPP_INSTRUCTIONS
        break
      case 'telegram':
        config.instructions = TELEGRAM_INSTRUCTIONS
        break
      default:
        assertNever(auth, 'MCP auth kind')
    }
  })
})
