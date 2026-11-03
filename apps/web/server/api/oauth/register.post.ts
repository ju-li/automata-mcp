/**
 * RFC 7591 dynamic client registration — how Claude and other MCP clients add
 * this server with no setup. Open by design; what bounds it is that a client
 * can do nothing until a signed-in person approves it on the consent page, which
 * names the client as unverified and shows where it will send them. Redirect
 * URIs are checked (`isAllowedRedirectUri`), registrations throttled per address.
 */
export default defineEventHandler(async (event) => {
  return await answerOAuth(event, 'client registration', async () => {
    const settings = requireOAuth()
    const body = await readBody(event).catch(() => undefined)
    return await registerClient(event, settings, body)
  })
})
