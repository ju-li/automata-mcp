import { z } from 'zod'
import type { TelegramHistory, TelegramMessage } from '~~/server/utils/telegram-db'

/**
 * Read tool. Refuses loudly when the chat is out of scope, like `read-messages`:
 * an empty page would read as "this conversation is empty".
 *
 * Two kinds of incompleteness are reported, and they are different:
 *
 *   paging   `hasMore` — this page is not the whole range. Page with `nextPage`.
 *   sync     `history` — the bridge never fetched this chat's older messages, or
 *            could not replay part of it. No amount of paging reaches those.
 *
 * A caller told only `hasMore: false` concludes it has read the chat from its
 * first message. When sync stopped short, that conclusion is wrong, so the
 * response says so in `note`.
 */
export default defineKindTool({
  name: 'read-telegram-messages',
  kind: 'telegram',
  title: 'Read Telegram messages',
  description:
    'Read one page of synced messages from one Telegram chat, newest first. Takes the '
    + '`chatId` from list-telegram-chats, as a string. Use `since`/`until` to target a '
    + 'date range and `topicId` for one topic of a forum supergroup. A response is one '
    + 'page: when `hasMore` is true there are older messages you have not seen, so call '
    + 'again with `nextPage` and the same `chatId`, `limit` and `window`, and keep going '
    + 'until `hasMore` is false before treating the range as read. `covered` is the span '
    + 'this page actually covers; `totalMatching` counts the messages in the range. When '
    + '`history.complete` is false, the chat has older messages that were never synced: '
    + 'reaching `hasMore: false` then means you reached the oldest *synced* message, not '
    + 'the start of the conversation, and `note` says why. `history.gapSince` means edits '
    + 'or deletions around that time may be missing. Telegram edits messages in place: '
    + '`text` is the current wording, `editedAt` says it changed, and the earlier wording '
    + 'is not available. Deleted messages are left out and counted in `deletedExcluded`; '
    + 'their text is not kept. Service messages (joins, pins, title changes) are left out '
    + 'unless `includeService` is set, counted in `serviceMessagesExcluded`. Reactions are '
    + 'counts on a message (`reactions`), never separate messages. A message you sent is '
    + 'marked `fromMe` and carries no `author`. To find a message by what it says, use '
    + 'search-telegram-messages instead of paging.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id written as a string of digits')
      .describe('Chat id from list-telegram-chats, as a string, e.g. "-1001234567890"'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many messages to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` messages, counting back from the newest. Walk this up while `hasMore` is true.'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date. Pass back `window.until` from a previous page when paging a range.'),
    topicId: z.number().int().positive().optional().describe('In a forum supergroup, only messages in this topic'),
    includeDeleted: z.boolean().default(false).describe('Include deleted messages as placeholders with no text. Off by default.'),
    includeService: z.boolean().default(false).describe('Include service messages: joins, leaves, pins, title and photo changes. Off by default.'),
  },
  handler: async ({ chatId, limit, page, since, until, topicId, includeDeleted, includeService }) => {
    const { instance, scope } = useMcpAuth()

    assertChatAllowed(scope, chatId)

    const chat = await telegramChat(instance, chatId)
    if (!chat) {
      throw createError({
        statusCode: 404,
        message: `No synced Telegram chat has the id ${chatId}. Take chat ids from list-telegram-chats.`,
      })
    }

    // Pinned as soon as a lower bound is named, for the reason read-messages
    // gives: an unpinned upper bound is *now*, which moves between pages.
    const range = {
      since: parseDateBound(since, 'since')?.toISOString(),
      until: parseDateBound(until, 'until')?.toISOString() ?? (since ? new Date().toISOString() : undefined),
    }

    const { messages, hasMore, total, excluded } = await listTelegramMessagesPage(instance, {
      chatId, limit, page, ...range, topicId, includeDeleted, includeService,
    })

    const covered = coveredSpan(messages)
    const notes = [
      hasMore ? incompleteNote(page, Boolean(range.since)) : undefined,
      !hasMore && !chat.history.complete ? unsyncedNote(chat.history) : undefined,
      chat.history.gapSince ? gapNote(chat.history.gapSince) : undefined,
      chat.migratedTo
        ? `This group was upgraded to a supergroup; messages since then are in chat ${chat.migratedTo}.`
        : undefined,
    ].filter((note): note is string => Boolean(note))

    return {
      chatId,
      ...(chat.title && { chatTitle: chat.title }),
      page,
      limit,
      count: messages.length,
      hasMore,
      ...(total !== undefined && {
        totalMatching: total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      }),
      ...(hasMore && { nextPage: page + 1 }),
      ...((range.since || range.until) && { window: range }),
      ...(covered && { covered }),
      ...(excluded.deleted > 0 && { deletedExcluded: excluded.deleted }),
      ...(excluded.service > 0 && { serviceMessagesExcluded: excluded.service }),
      ...((!chat.history.complete || chat.history.gapSince) && { history: chat.history }),
      ...(chat.migratedTo && { migratedTo: chat.migratedTo }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      messages,
    }
  },
})

function incompleteNote(page: number, bounded: boolean): string {
  const scope = bounded ? 'inside the requested window' : 'in this chat'
  return `Incomplete: this is page ${page}, and older messages ${scope} were NOT returned. Call `
    + `read-telegram-messages again with page: ${page + 1}, the same chatId and limit`
    + `${bounded ? ', and the same window bounds' : ''}, and keep going until hasMore is false. `
    + 'Do not summarise this range until then.'
}

const STOPPED_BECAUSE: Record<NonNullable<TelegramHistory['stoppedBecause']>, string> = {
  days: 'they are older than the period this connection syncs',
  count: 'this chat has more messages than this connection syncs per chat',
  skipped: 'the history of broadcast channels is not synced — only what arrived after the account was linked',
  inaccessible: 'Telegram did not let this account read the chat\'s history',
}

function unsyncedNote(history: TelegramHistory): string {
  const why = history.stoppedBecause
    ? STOPPED_BECAUSE[history.stoppedBecause]
    : 'older history is still being synced, so more may appear later'
  const oldest = history.oldestSyncedAt ? `, from ${history.oldestSyncedAt}` : ''
  return `This chat has older messages that were not synced, because ${why}. You have reached the `
    + `oldest synced message${oldest}, not the start of the conversation — say so rather than `
    + 'treating this as the whole history.'
}

function gapNote(gapSince: string): string {
  return `Sync could not replay part of this chat's history around ${gapSince}: messages from then are `
    + 'present, but edits or deletions made while the connection was offline may be missing.'
}

function coveredSpan(messages: TelegramMessage[]): { from: string, to: string } | undefined {
  const stamps = messages.map(message => message.timestamp).sort()
  const from = stamps[0]
  const to = stamps[stamps.length - 1]
  return from && to ? { from, to } : undefined
}
