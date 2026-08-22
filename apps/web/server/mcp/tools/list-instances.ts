/**
 * Example READ tool.
 *
 * Pattern to copy:
 *   - `title` is what MCP clients show in their UI; `description` is what the
 *     model reads to decide whether to call it.
 *   - `readOnlyHint: true` lets clients skip a human-in-the-loop confirmation.
 *   - Credentials come from `useEvolutionClient()`, which resolves the bearer
 *     token's user. Never accept an instance's API key as a tool argument.
 */
export default defineMcpTool({
  title: 'List WhatsApp instances',
  description:
    'List the Evolution API instances belonging to the authenticated user, with '
    + 'their connection state. Call this first — every other tool takes an '
    + '`instance` name from this list, and only instances in the `open` state can '
    + 'send or receive messages.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Reaches WhatsApp, an external system whose state this server does not own.
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const evolution = useEvolutionClient()
    return await evolution('/instance/fetchInstances')
  },
})
