import type { McpCredential } from '../utils/mcp-auth'

/**
 * Default MCP handler. Applies to both routes:
 *
 *   POST /mcp            Authorization: Bearer <token>   (static token or OAuth)
 *   POST /mcp/<token>    path-segment fallback for static tokens, registered by
 *                        modules/mcp-token-route.ts
 *
 * `middleware` runs inside the route handler, after routing (so
 * `getRouterParam(event, 'token')` is populated) and before any tool is
 * registered. Returning a `Response` short-circuits — nothing downstream runs.
 */
export default defineMcpHandler({
  middleware: async (event, next) => {
    const credential = await resolveMcpCredential(event)

    if (!credential) {
      // 401 + WWW-Authenticate. Never 200-with-an-error-body: to a client that
      // reads like a tool that ran and declined.
      return mcpUnauthorized(event)
    }

    if (credential.type === 'token') {
      // A valid credential beyond its organization's limits: 403, never 401,
      // since it works again the moment the limits rise. No limits — every
      // self-hosted organization — costs nothing here. See entitlements.ts.
      const { auth } = credential
      const refusal = await mcpLimitRefusal(auth.instance.org, auth.tokenId, auth.limits)
      if (refusal) return refusal

      // The MCP-only context key. UI code reads `event.context.user`; these two
      // are never cross-read. See server/utils/mcp-auth.ts.
      event.context.mcpAuth = auth
      return next()
    }

    // An OAuth session: each connection is checked against the limits on its
    // own, and one beyond them is left out rather than failing the others.
    // Only when every connection is refused does the request get the 403 —
    // still never a 401, which would send the client to throw its tokens away.
    const allowed = []
    let lastRefusal: Response | undefined
    for (const auth of credential.connections) {
      const refusal = await mcpLimitRefusal(auth.instance.org, auth.tokenId, auth.limits)
      if (refusal) lastRefusal = refusal
      else allowed.push(auth)
    }
    if (allowed.length === 0) return lastRefusal ?? mcpUnauthorized(event)

    // Deliberately NOT `event.context.mcpAuth`: a session has several
    // connections, and only its generated tools — each bound to one — may run.
    // Every static tool's `enabled` gate reads `mcpAuth`, finds none, and stays
    // off.
    event.context.mcpSession = { ...credential, connections: allowed } satisfies McpCredential
    return next()
  },

  // Resolved after the middleware (see mcp-session-tools.ts), so the session
  // set above is visible here. A static token gets the discovered tools, which
  // the toolkit then filters through each tool's `enabled` gate as before.
  tools: (event) => {
    const session = event.context.mcpSession as Extract<McpCredential, { type: 'session' }> | undefined
    return session ? sessionToolsFor(session.connections) : allTools
  },
})
