import { z } from 'zod'

const TELEGRAM_MAX_TEXT = 4096

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
    + 'get-telegram-status first. Messages cannot be unsent from here. The account owner '
    + 'may have set a disclaimer line that is appended to every message automatically (and '
    + 'counts toward the 4096-character limit); when one was, the response names it in '
    + '`disclaimerAppended`. Do not add a sign-off of your own.',
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
    text: z.string().min(1).max(TELEGRAM_MAX_TEXT).describe('Message text, sent exactly as written (Telegram\'s limit is 4096 characters)'),
  },
  handler: async ({ chatId, username, text }) => {
    const { scope, sendDisclaimer } = useMcpAuth()

    if (Boolean(chatId) === Boolean(username)) {
      throw createError({ statusCode: 400, message: 'Pass exactly one of `chatId` or `username`.' })
    }

    // Checked before anything is resolved or sent: refusing here names the cut
    // to make, where the bridge would only relay Telegram's MESSAGE_TOO_LONG.
    const body = withSendDisclaimer(text, sendDisclaimer)
    if (body.length > TELEGRAM_MAX_TEXT) {
      throw createError({
        statusCode: 400,
        message: `With the disclaimer this account appends to every message, the text is `
          + `${body.length} characters — over Telegram's ${TELEGRAM_MAX_TEXT}. Shorten it by at `
          + `least ${body.length - TELEGRAM_MAX_TEXT} characters. Nothing was sent.`,
      })
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
      const result = await bridge.send(target, body)
      return sendDisclaimer ? { ...result, disclaimerAppended: sendDisclaimer } : result
    }
    catch (error) {
      relayBridgeError(error, 'send the message')
    }
  },
})
