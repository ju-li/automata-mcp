/**
 * Read tool. Chat scope is applied by filtering rather than refusing — a listing
 * is the honest answer to "what can I see", so a scoped token sees its own
 * conversations and simply does not learn the others exist.
 *
 * **This answers with one page, and says so.** `listChats` returns a `ChatPage`
 * whose `hasMore` means "the page came back full", and dropping it here left the
 * only read tool that presents a page as a complete listing — the exact gap
 * `read-messages` and `list-tables` both carry an envelope to close. A model
 * told nothing concludes these are all the conversations there are.
 *
 * No page-size or offset argument, though, and that is not an omission: naming
 * the rows costs Evolution's entire contact table per call (see `listChats`), so
 * walking a small `skip` is far more expensive than one large page. The page
 * size stays this server's decision.
 */
export default defineKindTool({
  name: 'list-chats',
  kind: 'whatsapp',
  title: 'List WhatsApp chats',
  description:
    'List recent WhatsApp conversations, most recently active first, with the '
    + '`jid` needed by read-messages. Includes conversations imported from the '
    + 'phone when the account was paired, not only ones active since. If this '
    + 'connector is scoped to specific chats, only those are listed. This '
    + 'answers with one page, most recently active first: when `hasMore` is true '
    + 'there are older conversations it did not include, so do not report the '
    + 'list as complete or conclude that a chat does not exist — search-messages '
    + 'finds a conversation by what was said in it.',
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
    const { chats, hasMore } = await listChats(instance)
    const visible = filterChatsToScope(scope, chats)

    return {
      // `count` is what survived scope; `hasMore` is about the page underneath
      // it, so a scoped token can legitimately see few chats and still be told
      // there are more. Wrong only in the safe direction, as everywhere else: a
      // page that came back exactly full reports true and costs nothing but a
      // sentence.
      count: visible.length,
      hasMore,
      ...(hasMore && {
        note: 'This is one page of conversations, ordered by most recent activity, '
          + 'and there are older ones it does not include. Do not tell the user '
          + 'these are all their chats. Use search-messages to find a conversation '
          + 'by what was said in it rather than assuming it does not exist.',
      }),
      chats: visible,
    }
  },
})
