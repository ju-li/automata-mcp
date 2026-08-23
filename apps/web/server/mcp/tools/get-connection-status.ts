/**
 * Example READ tool.
 *
 * Pattern to copy:
 *   - `title` is what MCP clients show in their UI; `description` is what the
 *     model reads to decide whether to call it.
 *   - `readOnlyHint: true` lets clients skip a human-in-the-loop confirmation.
 *   - No instance argument. The connector token is bound to one WhatsApp
 *     account, so `useEvolutionClient()` already resolves to it. Never accept
 *     an account identifier or an API key as a tool argument.
 */
export default defineMcpTool({
  title: 'Check WhatsApp connection',
  description:
    'Report whether the connected WhatsApp account is currently online, along with '
    + 'the profile it is signed in as and how many messages, chats and contacts have '
    + 'been recorded. Call this before sending anything: only an account in the '
    + '`open` state can send or receive.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Reaches WhatsApp, an external system whose state this server does not own.
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance } = useMcpAuth()
    return await getInstanceStatus(instance)
  },
})
