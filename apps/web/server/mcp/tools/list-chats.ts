/**
 * Read tool. Chat scope is applied by filtering rather than refusing — a listing
 * is the honest answer to "what can I see", so a scoped token sees its own
 * conversations and simply does not learn the others exist.
 */
export default defineMcpTool({
  name: 'list-chats',
  enabled: event => isToolAllowed(event, 'list-chats'),
  title: 'List WhatsApp chats',
  description:
    'List recent WhatsApp conversations, most recently active first, with the '
    + '`jid` needed by read-messages. Only conversations that have exchanged a '
    + 'message since the account was connected appear here. If this connector is '
    + 'scoped to specific chats, only those are listed.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance, scope } = useMcpAuth()

    // Fetches a page and filters. A scoped token with chats far down a very long
    // list could miss some; raise the page size here if that becomes real.
    const chats = await listChats(instance)
    const visible = filterChatsToScope(scope, chats)

    return { chats: visible, count: visible.length }
  },
})
