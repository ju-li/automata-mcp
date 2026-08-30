import { z } from 'zod'
import type { ChatMessage } from '~~/server/utils/chats'

/**
 * Read tool. Unlike list-chats this refuses loudly when the requested chat is out
 * of scope: returning an empty history would read as "this conversation is
 * empty", which is a different and wrong statement.
 *
 * The same principle governs the response envelope. Evolution answers
 * newest-first and caps at `limit`, so a page of a `since`-bounded window is
 * missing the *old* end — the part the caller named. Returned bare, it reads as
 * the whole window, and a model summarising it writes a confident summary with a
 * hole in the middle. So every response says whether it is complete
 * (`hasMore`), what span it actually covers (`covered`), and how to get the
 * rest (`nextPage`, plus a `note` in words because the flag alone was not
 * enough).
 */
export default defineMcpTool({
  name: 'read-messages',
  enabled: event => isToolAllowed(event, 'read-messages'),
  title: 'Read WhatsApp messages',
  description:
    'Read one page of messages from one WhatsApp conversation, newest first. '
    + 'Takes the `jid` returned by list-chats. Covers the history imported when '
    + 'the account was paired as well as everything since, so older '
    + 'conversations are reachable — use `since`/`until` to target a date range. '
    + 'A response is one page, not the whole range: when `hasMore` is true there '
    + 'are older messages you have not seen, so call again with `nextPage` and '
    + 'the same `jid`, `limit` and `window` bounds, and keep going until '
    + '`hasMore` is false before treating the range as fully read. `covered` '
    + 'reports the span this page actually covers, which for a truncated range is '
    + 'narrower than the one you asked for, and `totalMatching`/`totalPages` say '
    + 'how much the range holds in full. Reaction messages are left out unless '
    + '`includeReactions` is set. To find a message by what it says, '
    + 'prefer search-messages when this connector offers it.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).describe('Chat identifier from list-chats, e.g. 5511999999999@s.whatsapp.net'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many messages to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` messages, counting back from the newest. Walk this up while `hasMore` is true.'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date. Pass back the `window.until` from a previous page when paging a range.'),
    includeReactions: z.boolean().default(false).describe(
      'Include reaction messages. Each reaction is its own record — an id, an '
      + 'author, a timestamp and an emoji — so in an active group they are a '
      + 'large share of a page while rarely mattering for reconstructing the '
      + 'conversation. Off by default for that reason; turn it on when who '
      + 'reacted is the question.',
    ),
  },
  handler: async ({ jid, limit, page, since, until, includeReactions }) => {
    const { instance, scope } = useMcpAuth()

    assertChatAllowed(scope, jid)

    // Named `range` rather than `window` only to keep the DOM global unshadowed;
    // it goes back to the caller as `window`.
    const range = {
      since: toIsoDate(since, 'since'),
      // Pin the upper bound as soon as the caller names a lower one. Evolution
      // honours a range only when both bounds are present, so `listMessages`
      // widens a one-sided one — and it widens `until` to *now*, a value that
      // moves between calls. Paging an unpinned window would take page 2 from a
      // different range than page 1. Pinned here and echoed back, paging is
      // repeatable. Left alone when there is no `since`: putting a
      // `messageTimestamp` predicate on an ordinary unfiltered read would hit a
      // table Evolution indexes by instance and nothing else.
      until: toIsoDate(until, 'until') ?? (since ? new Date().toISOString() : undefined),
    }

    // `includeReactions` is passed alongside `range` rather than folded into it:
    // `range` is echoed back to the caller as `window`, and it should describe
    // the time bounds and nothing else.
    const { messages, hasMore, total } = await listMessages(instance, jid, { limit, page, ...range, includeReactions })

    const covered = coveredSpan(messages)
    const bounded = Boolean(range.since || range.until)

    return {
      jid,
      page,
      limit,
      count: messages.length,
      // Wrong only in the safe direction: a page that came back full reports
      // `true` even when it happens to be the last one, which costs one more
      // call returning nothing. A partial answer is never reported as complete.
      hasMore,
      ...(total !== undefined && {
        totalMatching: total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      }),
      ...(hasMore && { nextPage: page + 1 }),
      ...(bounded && { window: range }),
      // The span these messages actually cover, which is the visible half of
      // what truncation took: with `since` set and `hasMore` true, everything
      // between `window.since` and `covered.from` is still unread.
      ...(covered && { covered }),
      ...(hasMore && { note: incompleteNote({ page, limit, count: messages.length, range }) }),
      // Same principle as `hasMore`, for a different kind of gap: a whole class
      // of message is missing, and a caller that does not know it was dropped
      // reads the silence as "nobody reacted".
      ...(!includeReactions && { reactionsExcluded: true }),
      messages,
    }
  },
})

/**
 * Said in words as well as in a flag. The failure this exists to prevent was a
 * caller reading `count: 200` against `limit: 200` and concluding the window
 * held exactly 200 messages.
 */
function incompleteNote(
  { page, limit, count, range }:
  { page: number, limit: number, count: number, range: { since?: string, until?: string } },
): string {
  const scope = range.since ? 'inside the requested window' : 'in this conversation'
  const first = (page - 1) * limit + 1
  const last = (page - 1) * limit + count

  return `Incomplete: this is page ${page} — messages ${first}-${last} ${scope}, counting back from the `
    + `newest, and not all of them. Older messages ${scope} were NOT returned. Call read-messages again `
    + `with page: ${page + 1}, the same jid and limit`
    + `${range.since || range.until ? ', and the same window bounds' : ''}, and keep going until hasMore `
    + 'is false. Do not summarise this range until then.'
}

/**
 * Oldest and newest timestamp actually present, computed as a min/max rather
 * than read off the ends of the array. Some message types carry no timestamp at
 * all, and deriving the span from position would quietly become a lie if
 * Evolution's ordering ever changed.
 */
function coveredSpan(messages: ChatMessage[]): { from: string, to: string } | undefined {
  // ISO 8601 UTC strings sort chronologically as text; they all come from
  // `toISOString()`.
  const stamps = messages
    .map(message => message.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort()

  const from = stamps[0]
  const to = stamps[stamps.length - 1]

  return from && to ? { from, to } : undefined
}

/**
 * Evolution parses range bounds with `new Date(...)` and, on a value it cannot
 * read, produces `NaN` — which it then floors into a timestamp that matches
 * nothing. An unparseable date would come back as "no messages", so reject it.
 */
function toIsoDate(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw createError({
      statusCode: 400,
      message: `\`${label}\` is not a date I can read: ${value}. Use a format like 2024-03-01 or 2024-03-01T12:00:00Z.`,
    })
  }

  return parsed.toISOString()
}
