import { z } from 'zod'

/**
 * Fetch the file a Telegram message carries, through the bridge. Never stored.
 * Same rules as `download-whatsapp-media` (WhatsApp): opt-in by name (never covered by
 * "All actions"), chat scope asserted before anything is fetched, small files
 * inline and larger ones by a signed URL only this token can follow.
 *
 * Telegram does not report a file's size in the synced row, so `auto` first
 * opens the file inline-capped: a reported size over the inline limit is
 * refused as soon as the bridge's headers arrive (413, nothing read), one with
 * no reported size after at most one chunk past it; the answer is then a link,
 * which fetches the file when followed. `url` mints the link without asking the
 * bridge anything — the synced row says only that there is media — so a file
 * that is self-destructing or over the cap is refused when the link is
 * followed (charged then, like any followed link), and the description says so.
 */
export default defineKindTool({
  name: 'download-telegram-media',
  kind: 'telegram',
  title: 'Download Telegram media',
  description:
    'Download the file a Telegram message carries — a photo, video, video note, voice message, '
    + 'audio file, sticker or document. Pass the `chatId` and the message `id` exactly as '
    + 'read-telegram-messages returned them; messages with a file carry `media`. Images come back '
    + 'as images and other files as embedded files, when small enough; a larger file comes back as '
    + 'a `url` that works for ten minutes when fetched with this connection\'s Authorization header, '
    + 'and only for this token (a client that puts the token in the URL path cannot follow it: use '
    + '`inline`). `delivery` chooses: `auto` (default) inlines small files, `url` always returns a '
    + 'link without fetching the file first (a file that turns out too large or not downloadable is '
    + 'refused when the link is followed), `inline` never does. Self-destructing media is not downloadable, and the account must be '
    + 'online (get-telegram-status). Fetch only what the task needs: each download — inline, or a link '
    + 'followed — fetches the file again.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  expensive: true,
  optIn: true,
  inputSchema: {
    chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id written as a string of digits')
      .describe('Chat id from list-telegram-chats or read-telegram-messages, as a string'),
    messageId: z.number().int().positive().max(2 ** 31 - 1).describe('The message `id` from read-telegram-messages'),
    delivery: z.enum(['auto', 'inline', 'url']).default('auto')
      .describe('auto: inline when small, else a signed URL. inline: never a URL. url: always a URL.'),
  },
  handler: async ({ chatId, messageId, delivery }) => {
    const auth = useMcpAuth()
    if (auth.kind !== 'telegram') throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

    assertChatAllowed(auth.scope, chatId)
    const mediaKind = await findTelegramMedia(auth, chatId, messageId)
    const inlineMax = mediaInlineMaxBytes()
    const link = (over?: { size?: number }) => {
      const signed = signMediaUrl({ k: 'telegram', i: auth.instance.id, t: auth.tokenId, c: chatId, m: String(messageId) })
      if (!signed) throw signedUrlUnavailable(inlineMax, over)
      return mediaUrlResult({ chatId, messageId, media: mediaKind }, signed.url, signed.expiresAt)
    }

    if (delivery === 'url') return link()

    try {
      const { meta, file } = await downloadTelegramMedia(auth, chatId, messageId, inlineMax)
      return mediaInlineResult({ chatId, messageId, ...meta }, file)
    }
    catch (error) {
      if (httpStatusOf(error) !== 413) throw error
      const size = (error as { data?: { size?: unknown } }).data?.size
      if (typeof size === 'number' && size > telegramMediaMaxBytes()) {
        throw createError({
          statusCode: 413,
          message: `This file is ${formatBytes(size)}, larger than the ${formatBytes(telegramMediaMaxBytes())} this connector fetches.`,
        })
      }
      if (delivery === 'inline') {
        throw createError({
          statusCode: 413,
          message: `This file is over the ${formatBytes(inlineMax)} returned inline. Call again with delivery: "url".`,
        })
      }
      return link({ size: typeof size === 'number' ? size : undefined })
    }
  },
})
