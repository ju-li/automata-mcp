import { z } from 'zod'

/**
 * Read tool. Scope is a predicate in the SQL: a scoped token lists its own chats
 * and never learns the others exist.
 *
 * Unlike `list-chats` this pages. Naming a WhatsApp chat costs Evolution's whole
 * contact table per call, so that tool keeps the page size to itself; a Telegram
 * listing is one indexed query against the bridge's database, so paging is cheap
 * and the caller may walk it.
 */
export default defineKindTool({
  name: 'list-telegram-chats',
  kind: 'telegram',
  title: 'List Telegram chats',
  description:
    'List synced Telegram chats — private chats, groups, supergroups and channels — '
    + 'most recently active first, with the `chatId` needed by the other Telegram tools. '
    + 'A `chatId` is a string of digits (negative for groups and channels); always pass '
    + 'it back as a string. If this connector is scoped to specific chats, only those are '
    + 'listed. This answers one page: when `hasMore` is true there are more chats, so walk '
    + '`nextPage` before concluding a chat does not exist. Each chat carries `history`: '
    + 'when `history.complete` is false, older messages in that chat were not synced. A '
    + 'chat with `migratedTo` is a group that was upgraded; its newer messages are in the '
    + 'chat that names.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(100).describe('How many chats to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page, most recently active first. Walk this up while `hasMore` is true.'),
  },
  handler: async ({ limit, page }) => {
    const { instance, scope } = useMcpAuth()

    const { chats, hasMore } = await listTelegramChats(instance, {
      take: limit,
      skip: (page - 1) * limit,
      allowedChatIds: scopedTelegramChatIds(scope),
    })

    return {
      page,
      count: chats.length,
      hasMore,
      ...(hasMore && {
        nextPage: page + 1,
        note: 'This is one page of chats, most recently active first, and there are more. '
          + 'Do not tell the user these are all their chats; call list-telegram-chats again '
          + `with page: ${page + 1}, or use search-telegram-messages to find a chat by what was said in it.`,
      }),
      chats,
    }
  },
})
