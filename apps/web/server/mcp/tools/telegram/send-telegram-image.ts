import { z } from 'zod'

/** Telegram's caption limit for an ordinary account (Premium allows more; we do not know which this is). */
const TELEGRAM_MAX_CAPTION = 1024

/**
 * Write tool: one photo, optional caption. Recipient handling is
 * `send-telegram-message`'s — a `username` is resolved through the bridge
 * before the scope check, failing closed — and it is a tool of its own so a
 * token scoped to text sends does not silently gain images.
 *
 * The bridge receives the bytes we fetched and checked (`loadSendImage`),
 * never a URL: teleproto would otherwise hand Telegram an external-photo URL
 * or download it from the bridge's network.
 */
export default defineKindTool({
  name: 'send-telegram-image',
  kind: 'telegram',
  title: 'Send Telegram image',
  expensive: true,
  description:
    'Send one image (JPEG or PNG, at most 5 MB) as a photo from the connected Telegram account, '
    + 'with an optional caption (Telegram\'s limit is 1024 characters). Pass the image as `imageUrl` '
    + '(a public link this server downloads) or as `imageBase64` — exactly one. Address it like '
    + 'send-telegram-message: a `chatId` from list-telegram-chats or a `username`, exactly one of '
    + 'the two. The caption is sent exactly as written — formatting marks are not interpreted. The '
    + 'account must be in the `open` state; check with get-telegram-status first. Messages cannot '
    + 'be unsent from here. The account owner may have set a disclaimer line that is appended to '
    + 'every caption automatically (and counts toward the limit); when one was, the response names '
    + 'it in `disclaimerAppended`.',
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
    ...sendImageInputSchema,
    caption: z.string().max(TELEGRAM_MAX_CAPTION).optional()
      .describe('Text shown under the photo, sent exactly as written (at most 1024 characters)'),
  },
  handler: async ({ chatId, username, imageUrl, imageBase64, caption }) => {
    const { scope, sendDisclaimer } = useMcpAuth()

    if (Boolean(chatId) === Boolean(username)) {
      throw createError({ statusCode: 400, message: 'Pass exactly one of `chatId` or `username`.' })
    }

    const text = captionWithDisclaimer(caption, sendDisclaimer) ?? ''
    if (text.length > TELEGRAM_MAX_CAPTION) {
      throw createError({
        statusCode: 400,
        message: `With the disclaimer this account appends to every message, the caption is `
          + `${text.length} characters — over Telegram's ${TELEGRAM_MAX_CAPTION}. Shorten it by at `
          + `least ${text.length - TELEGRAM_MAX_CAPTION} characters. Nothing was sent.`,
      })
    }

    const bridge = useTelegramBridge()
    // Before the download: a refused recipient costs no fetch.
    const target = await resolveTelegramSendTarget(bridge, scope, { chatId, username }, 'image')

    const image = await loadSendImage({ imageUrl, imageBase64 })

    try {
      const result = await bridge.sendPhoto(target, image, text)
      return sendDisclaimer ? { ...result, disclaimerAppended: sendDisclaimer } : result
    }
    catch (error) {
      // An older bridge has no photo route: say so, rather than "Not found".
      if (isBridgeRouteMissing(error)) {
        console.error('[telegram] send-telegram-image: the Telegram bridge has no photo route; it needs updating')
        throw createError({
          statusCode: 503,
          message: 'This connection\'s Telegram bridge is too old to send images; it needs updating. Nothing was sent.',
        })
      }
      relayBridgeError(error, 'send the image')
    }
  },
})
