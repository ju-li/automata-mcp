import { z } from 'zod'

/**
 * Read tool. Unlike list-chats this refuses loudly when the requested chat is out
 * of scope: returning an empty history would read as "this conversation is
 * empty", which is a different and wrong statement.
 */
export default defineMcpTool({
  name: 'read-messages',
  enabled: event => isToolAllowed(event, 'read-messages'),
  title: 'Read WhatsApp messages',
  description:
    'Read messages from one WhatsApp conversation, newest first. Takes the `jid` '
    + 'returned by list-chats. Covers the history imported when the account was '
    + 'paired as well as everything since, so older conversations are reachable — '
    + 'use `page` to walk back beyond `limit`, or `since`/`until` to target a date '
    + 'range. To find a message by what it says, prefer search-messages when this '
    + 'connector offers it.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).describe('Chat identifier from list-chats, e.g. 5511999999999@s.whatsapp.net'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many messages to return'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` messages, counting back from the newest'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date'),
  },
  handler: async ({ jid, limit, page, since, until }) => {
    const { instance, scope } = useMcpAuth()

    assertChatAllowed(scope, jid)

    const messages = await listMessages(instance, jid, {
      limit,
      page,
      since: toIsoDate(since, 'since'),
      until: toIsoDate(until, 'until'),
    })

    return { jid, page, messages, count: messages.length }
  },
})

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
