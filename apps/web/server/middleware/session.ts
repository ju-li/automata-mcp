/**
 * Attaches the session cookie's user to `event.context.user` for the UI.
 *
 * The MCP surface is excluded before anything else happens. This is load-bearing:
 * if cookies were parsed on /mcp, a browser that is signed in to this app and
 * also has an MCP client pointed at it could authenticate a tool call with a
 * cookie instead of a token. MCP auth lives entirely in server/mcp/index.ts.
 */
export default defineEventHandler(async (event) => {
  if (isMcpPath(event.path)) return

  // Webhooks authenticate with a shared secret, not a cookie.
  if (event.path.startsWith('/api/webhook/')) return

  // The OAuth endpoints an MCP client calls authenticate with a code, a PKCE
  // verifier or a refresh token — never a cookie, so one is never parsed there.
  // The consent routes (`/api/oauth/authorize…`) are the web surface and do read it.
  if (isOAuthClientPath(event.path)) return

  event.context.user = await getSessionUser(event)
})
