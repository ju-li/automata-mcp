import { z } from 'zod'

/**
 * Write tool. Not idempotent: two calls send two messages.
 *
 * A recipient named by `username` is resolved through the bridge **before** the
 * scope check, so a scoped token cannot reach by name a chat it could not reach
 * by id. That lookup fails closed: an unreachable bridge refuses the send rather
 * than skipping the check.
 */
export default defineKindTool({
  name: 'send-telegram-message',
  kind: 'telegram',
  title: 'Send Telegram message',
  description:
    'Send a plain-text Telegram message from the connected account, to a `chatId` from '
    + 'list-telegram-chats or to a `username` (a public @username or t.me link; a phone '
    + 'number works only where that person\'s privacy settings allow it). Pass exactly one '
    + 'of the two. The text is sent exactly as written — formatting marks such as ** are '
    + 'not interpreted. The account must be in the `open` state; check with '
    + 'get-telegram-status first. Messages cannot be unsent from here.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id written as a string of digits').optional()
      .describe('Chat id from list-telegram-chats, as a string'),
    username: z.string().min(1).max(64).optional()
      .describe('Instead of chatId: a public @username, a t.me link, or a phone number'),
    text: z.string().min(1).max(4096).describe('Message text, sent exactly as written (Telegram\'s limit is 4096 characters)'),
  },
  handler: async ({ chatId, username, text }) => {
    const { scope } = useMcpAuth()

    if (Boolean(chatId) === Boolean(username)) {
      throw createError({ statusCode: 400, message: 'Pass exactly one of `chatId` or `username`.' })
    }

    const bridge = useTelegramBridge()

    let target: string
    if (chatId) {
      target = chatId
    }
    else {
      try {
        target = (await bridge.resolve(username!)).chatId
      }
      catch (error) {
        relayBridgeError(error, 'look up that recipient, so the message was not sent')
      }
    }

    assertChatAllowed(scope, target)

    try {
      return await bridge.send(target, text)
    }
    catch (error) {
      relayBridgeError(error, 'send the message')
    }
  },
})
