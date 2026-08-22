/**
 * Default MCP handler. Applies to both routes:
 *
 *   POST /mcp            Authorization: Bearer <token>
 *   POST /mcp/<token>    path-segment fallback, registered by
 *                        modules/mcp-token-route.ts
 *
 * `middleware` runs inside the route handler, after routing (so
 * `getRouterParam(event, 'token')` is populated) and before any tool is
 * registered. Returning a `Response` short-circuits — nothing downstream runs.
 */
export default defineMcpHandler({
  middleware: async (event, next) => {
    const auth = await resolveMcpAuth(event)

    if (!auth) {
      // 401 + WWW-Authenticate. Never 200-with-an-error-body: to a client that
      // reads like a tool that ran and declined.
      return mcpUnauthorized()
    }

    // The MCP-only context key. UI code reads `event.context.user`; these two
    // are never cross-read. See server/utils/mcp-auth.ts.
    event.context.mcpAuth = auth

    return next()
  },
})
