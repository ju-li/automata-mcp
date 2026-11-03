/**
 * The token endpoint: `authorization_code` and `refresh_token` grants for
 * public clients (no secret; PKCE instead). Form-encoded per RFC 6749, JSON
 * accepted too — h3's `readBody` parses both.
 *
 * Never reads the session cookie: whoever holds a code or refresh token is the
 * credential here, and the browser that approved the code is not the caller.
 * A database failure answers 503, never `invalid_grant` — see `answerOAuth`.
 */
export default defineEventHandler(async (event) => {
  return await answerOAuth(event, 'token request', async () => {
    requireOAuth()
    const body = (await readBody(event).catch(() => undefined)) ?? {}
    if (typeof body !== 'object') throw new OAuthError(400, 'invalid_request', 'Expected a form or JSON body.')
    const params = body as Record<string, unknown>

    switch (params.grant_type) {
      case 'authorization_code':
        return await exchangeAuthorizationCode(params)
      case 'refresh_token':
        return await refreshAccessToken(params)
      default:
        throw new OAuthError(400, 'unsupported_grant_type', 'Supported: authorization_code, refresh_token.')
    }
  })
})
