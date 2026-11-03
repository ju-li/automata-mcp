/**
 * RFC 7009 token revocation. Signs the grant out (the client's tokens stop
 * working; the holder can sign in again) rather than revoking the grant an
 * admin created — that stays the Revoke button's job.
 */
export default defineEventHandler(async (event) => {
  return await answerOAuth(event, 'token revocation', async () => {
    requireOAuth()
    const body = (await readBody(event).catch(() => undefined)) ?? {}
    return await revokeOAuthToken(typeof body === 'object' ? body as Record<string, unknown> : {})
  })
})
