import type { McpAuth } from './mcp-auth'

type TelegramAuth = Extract<McpAuth, { kind: 'telegram' }>

/**
 * Telegram media for one message, through the bridge. Shared by the
 * `download-telegram-media` tool and the signed-URL route, so both run the same
 * checks. The caller asserts chat scope first (`assertChatAllowed`); the bridge
 * then fetches the message through that chat and refuses one from any other.
 *
 * **Streamed, never stored.** The bridge sends the file as raw bytes, chunk by
 * chunk, as it downloads them from Telegram. The signed-URL route pipes that
 * stream straight to the caller (`pipeMediaToResponse`, with backpressure), so
 * no layer holds the whole file. Only an inline tool result reads it into memory, because MCP
 * carries the file inside the JSON result; that read is capped at the inline
 * limit (5 MiB by default).
 */

/** The bridge's own ceiling on one download (`MEDIA_MAX_BYTES` in apps/telegram-bridge/src/http.ts). */
const BRIDGE_MEDIA_MAX_BYTES = 50 * 1024 * 1024

/** The most this connector fetches from Telegram: the configured cap, or the bridge's ceiling if lower. */
export function telegramMediaMaxBytes(): number {
  return Math.min(mediaMaxBytes(), BRIDGE_MEDIA_MAX_BYTES)
}

/**
 * The synced message's media kind, or a loud refusal: 404 when no such
 * message is synced in this chat, 422 when it carries no media.
 */
export async function findTelegramMedia(auth: TelegramAuth, chatId: string, messageId: number): Promise<string> {
  const media = await telegramMessageMedia(auth.instance, chatId, messageId)
  if (media === undefined) {
    throw createError({
      statusCode: 404,
      message: `No message ${messageId} is synced in chat ${chatId}. Pass ids exactly as read-telegram-messages returned them.`,
    })
  }
  if (media === null) {
    throw createError({ statusCode: 422, message: 'This message carries no media.' })
  }
  return media
}

/**
 * Open the file as a byte stream from the bridge, with what the bridge says
 * about it. The bridge refuses a file over `maxBytes` from Telegram's reported
 * size before sending anything (413, keeping that size so a caller can tell
 * "too large for inline" from "too large at all") and cuts the stream off if
 * the bytes pass it anyway.
 */
export async function openTelegramMedia(
  auth: TelegramAuth,
  chatId: string,
  messageId: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ meta: MediaMeta, body: ReadableStream<Uint8Array>, cap: number }> {
  const cap = Math.min(maxBytes, BRIDGE_MEDIA_MAX_BYTES)
  let opened: { headers: Headers, body: ReadableStream<Uint8Array> }
  try {
    opened = await createTelegramBridge(auth.telegram).media(chatId, messageId, cap, signal)
  }
  catch (error) {
    const status = httpStatusOf(error)
    const data = (error as { data?: { error?: unknown, size?: unknown } } | undefined)?.data
    const said = data?.error
    if (status === 413) {
      throw createError({
        statusCode: 413,
        message: typeof said === 'string' ? said : `This file is larger than the ${formatBytes(cap)} this connector fetches.`,
        // Telegram's reported size, when the bridge refused before sending.
        data: typeof data?.size === 'number' ? { size: data.size } : undefined,
      })
    }
    if (status === 502) {
      // The bridge answers this deliberately and does not log it; ids only here.
      console.error(`[media] Telegram download on connection ${auth.instance.id} failed: the bridge answered 502`)
      throw createError({ statusCode: 502, message: typeof said === 'string' ? said : 'Telegram returned no file for this message.' })
    }
    // An older bridge has no media route: its router's 404 carries no `code`,
    // where every 404 the bridge means does. Say so, rather than "Not found".
    if (isBridgeRouteMissing(error)) {
      console.error('[telegram] download-telegram-media: the Telegram bridge has no media route; it needs updating')
      throw createError({
        statusCode: 503,
        message: 'This connection\'s Telegram bridge is too old to download media; it needs updating.',
      })
    }
    relayBridgeError(error, 'download the file')
  }

  const { headers, body } = opened
  const fileName = cleanFileName(decodeHeader(headers.get('x-media-file-name')))
  // Absent stays absent: `Number(null)` is 0, which would read as an empty file.
  const sizeHeader = headers.get('x-media-size')
  const size = sizeHeader && /^\d{1,15}$/.test(sizeHeader) ? Number(sizeHeader) : undefined
  return {
    meta: {
      mediaType: headers.get('x-media-type') ?? 'document',
      mimeType: cleanMimeType(headers.get('content-type')),
      ...(fileName && { fileName }),
      ...(size !== undefined && { size }),
    },
    body,
    cap,
  }
}

/**
 * The whole file in memory, for an inline tool result: one media slot, the
 * stream read capped at `maxBytes` (413 the moment it passes it).
 *
 * The bridge is asked for the **overall** limit and this read enforces the
 * smaller one itself: the bridge refuses whole chunks rather than overrun its
 * cap, so a cap given to it would end in a broken stream, not a 413. This way a
 * file over `maxBytes` whose size Telegram did not report is caught here — a
 * clean 413 that `auto` turns into a link — after at most one extra chunk. A
 * file whose reported size is over `maxBytes` is refused as soon as the bridge's
 * headers arrive, and one over the overall limit by the bridge itself, both
 * with the size.
 */
export async function downloadTelegramMedia(
  auth: TelegramAuth,
  chatId: string,
  messageId: number,
  maxBytes: number,
): Promise<{ meta: MediaMeta, file: MediaFile }> {
  return await withMediaSlot(auth.instance.id, async () => {
    const cap = Math.min(maxBytes, BRIDGE_MEDIA_MAX_BYTES)
    const { meta, body } = await openTelegramMedia(auth, chatId, messageId, Math.max(cap, mediaMaxBytes()), requestAbortSignal())
    // The bridge's reported size (exact for a document) decides before a byte
    // is read; the capped read below is the backstop when it is missing or short.
    if (meta.size !== undefined && meta.size > cap) {
      await body.cancel().catch(() => {})
      throw createError({
        statusCode: 413,
        message: `This file is ${formatBytes(meta.size)}, larger than the ${formatBytes(cap)} this read accepts.`,
        data: { size: meta.size },
      })
    }
    const data = await readStreamCapped(body, cap)
    // The reported size is exact; a file of any other length is not this file.
    if (meta.size !== undefined && data.length !== meta.size) {
      throw createError({ statusCode: 502, message: 'Telegram returned a file of the wrong size.' })
    }
    return {
      meta: { ...meta, size: data.length },
      file: { data, mimeType: meta.mimeType, ...(meta.fileName && { fileName: meta.fileName }) },
    }
  })
}

function decodeHeader(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  }
  catch {
    return undefined
  }
}
