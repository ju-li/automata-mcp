/**
 * CORS for the OAuth endpoints a browser-based MCP client (the MCP Inspector,
 * web IDEs) calls directly: discovery, registration, token, revocation.
 *
 * None of them reads a cookie — the token endpoint authenticates with a PKCE
 * verifier or a refresh token — so `*` with no credentials gives a foreign page
 * nothing it could not get with curl. The consent routes under
 * `/api/oauth/authorize` are deliberately **not** here: they are cookie-
 * authenticated and only this app's own page may call them.
 *
 * Answers preflight itself, before routing, because the toolkit's method-less
 * 404 on the discovery paths would otherwise answer OPTIONS.
 */
const CORS_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/api/oauth/register',
  '/api/oauth/token',
  '/api/oauth/revoke',
])

export default defineEventHandler((event) => {
  const [pathname] = event.path.split('?')
  if (!CORS_PATHS.has(pathname!)) return

  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Max-Age': '600',
  })
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
})
