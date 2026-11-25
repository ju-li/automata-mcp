import { createHash } from 'node:crypto'
import type { McpAuth } from './mcp-auth'

type WhatsappAuth = Extract<McpAuth, { kind: 'whatsapp' }>

/**
 * WhatsApp media for one message: find it inside the token's chats, describe
 * it, and — when asked — download it through Evolution.
 *
 * One function serves the `download-whatsapp-media` tool and the signed-URL route, so
 * both run the same scope check against the same token on every fetch.
 */

export interface WhatsappMediaTarget {
  /** The chat as the caller named it. */
  jid: string
  messageId: string
  /** The message row, found inside the token's chats. */
  row: StoredMessage
  /** The media node itself, from that row. */
  media: WhatsappMediaNode
  meta: MediaMeta
}

/**
 * Resolve `messageId` in `jid` for this token, or refuse loudly: 403 for a chat
 * out of scope (from `expandChat`), 404 for no such message in that chat, 422
 * for a message with no downloadable file or one that is view-once.
 */
export async function findWhatsappMedia(auth: WhatsappAuth, jid: string, messageId: string): Promise<WhatsappMediaTarget> {
  // Asserts `jid` first; adds the same person's other JID only if the token
  // reaches it too. A message is then looked up inside those chats only.
  const links = await lidLinks(auth.instance)
  const chat = expandChat(auth.scope, links, jid)

  const row = await findMessageInChats(auth.instance, chat.jids, messageId)
  if (!row) {
    throw createError({
      statusCode: 404,
      message: `No message with id ${messageId} in this chat. Pass a message id exactly as read-messages returned it, with the same jid.`,
    })
  }

  const { info, node } = whatsappMediaOf(row.message, row.messageType ?? undefined)
  if (!info || !node) {
    throw createError({
      statusCode: 422,
      message: node?.viewOnce || isViewOnceWrapped(row.message)
        ? 'This is a view-once message; its media is not downloadable here.'
        : node?.node.mediaKey && !mediaLocated(node.node)
          ? 'WhatsApp did not record where this message\'s file is stored, so it cannot be downloaded.'
          : 'This message carries no downloadable file (photo, video, voice note, audio, document or sticker).',
    })
  }
  if (!mediaReferenceIsSafe(node.node)) {
    throw createError({
      statusCode: 422,
      message: 'This message\'s file points somewhere other than WhatsApp\'s media servers, so it was not downloaded.',
    })
  }

  return {
    jid,
    messageId,
    row,
    media: node,
    meta: {
      mediaType: info.mediaType,
      mimeType: info.mimetype ?? 'application/octet-stream',
      ...(info.fileName && { fileName: info.fileName }),
      ...(info.fileSize !== undefined && { size: info.fileSize }),
    },
  }
}

/** A handled error for a caller that went away: Nitro neither logs it nor anyone reads it. */
function callerGone() {
  return createError({ statusCode: 499, statusMessage: 'Client Closed Request' })
}

function isViewOnceWrapped(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  return Object.keys(message).some(key => key.startsWith('viewOnceMessage'))
}

/** Evolution's answer without its `base64` field, which `fetchBase64Media` decodes as it streams. */
interface EvolutionMedia {
  mediaType?: string
  fileName?: string
  mimetype?: string
}

/** Long enough for a large video through Evolution's own retry (it waits 5 s and tries again). */
const MEDIA_DOWNLOAD_DEADLINE_MS = 90_000

/** Where Baileys downloads a `directPath` from: `https://` + this host + the path, by string concatenation. */
const MEDIA_CDN_HOST = 'mmg.whatsapp.net'
/** A `directPath` as WhatsApp writes it (`/v/t62.7118-24/…enc?ccb=…&oh=…`): a path and query, nothing that could end the host. */
const DIRECT_PATH = /^\/[A-Za-z0-9\-._~%][A-Za-z0-9\-._~%/?=&+]*$/

/**
 * Whether the node's file reference stays on WhatsApp's media servers. The
 * stored payload is the sender's, and stock Evolution 2.3.7 (Baileys) fetches
 * it as given: `url` if present, else `https://mmg.whatsapp.net` + `directPath`
 * by plain concatenation — so `directPath: '.attacker.example/x'` names another
 * host, and a crafted `url` any host at all: a request from Evolution's network
 * to an address the sender chose. Both are checked by how a URL parser reads
 * them, and a node failing either is refused, never cleaned: on every engine,
 * since a reforged server reloading the stored row would fetch the same thing.
 */
function mediaReferenceIsSafe(node: Record<string, unknown>): boolean {
  const { url, directPath } = node
  if (url === undefined && directPath === undefined) return false
  if (directPath !== undefined) {
    if (typeof directPath !== 'string' || !DIRECT_PATH.test(directPath)) return false
    if (!onHost(`https://${MEDIA_CDN_HOST}${directPath}`, host => host === MEDIA_CDN_HOST)) return false
  }
  if (url !== undefined) {
    if (typeof url !== 'string' || !onHost(url, host => host.endsWith('.whatsapp.net'))) return false
  }
  return true
}

/** `https:`, no credentials, default port, and a hostname `allowed` accepts. */
function onHost(value: string, allowed: (hostname: string) => boolean): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  }
  catch {
    return false
  }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.port === ''
    && allowed(parsed.hostname.toLowerCase())
}

/**
 * The media node as Evolution should download it: this row's node alone, under
 * its own key, already checked by `mediaReferenceIsSafe` — and without `url`
 * when it has a `directPath`, so Baileys builds the address on
 * mmg.whatsapp.net itself (some stored `url`s are a bare
 * `https://web.whatsapp.net`, which serves no file). Sending the node alone
 * also skips wrappers (an album item's `associatedChildMessage`) Evolution
 * would not unwrap.
 */
function downloadPayload(media: WhatsappMediaNode): Record<string, unknown> {
  if (!mediaReferenceIsSafe(media.node)) {
    throw createError({ statusCode: 422, message: 'This message\'s file points somewhere other than WhatsApp\'s media servers, so it was not downloaded.' })
  }
  const { url, ...rest } = media.node
  return { [media.key]: rest.directPath === undefined ? { ...rest, url } : rest }
}

/**
 * Download the file through Evolution's `getBase64FromMediaMessage`, which
 * decrypts it from WhatsApp's CDN (asking the phone to re-upload expired media).
 *
 * Evolution 2.3.7 downloads from the payload as sent (`downloadPayload`).
 * evolution-api-reforged ignores caller content on this route and reloads the
 * stored message: from 3.3.2 by the full key we send (this row's chat, id and
 * direction); before 3.3.2 by `key.id` alone, which can be another chat's
 * message when the sender-chosen id repeats. So the bytes are checked against
 * this row's `fileSha256` before they are handed on (`assertFileMatches`).
 *
 * The answer is read through `fetchBase64Media`: the file is decoded from the
 * answer's base64 as it streams and held once, and one over `maxBytes` — the
 * sender's `fileLength` is only a claim — is cut off while it streams. One of
 * this process's media slots is held throughout.
 */
export async function downloadWhatsappMedia(auth: WhatsappAuth, target: WhatsappMediaTarget, maxBytes: number): Promise<MediaFile> {
  return await withMediaSlot(auth.instance.id, () => fetchWhatsappMedia(auth, target, maxBytes))
}

/**
 * `downloadWhatsappMedia` without the slot, for a caller that holds one itself
 * for longer — the signed-URL route keeps it until the file is delivered.
 */
export async function fetchWhatsappMedia(auth: WhatsappAuth, target: WhatsappMediaTarget, maxBytes: number): Promise<MediaFile> {
  const evolution = createEvolutionClient(auth.evolution)
  let answer: { fields: EvolutionMedia | null, data: Buffer | undefined }
  try {
    answer = await fetchBase64Media<EvolutionMedia>(
      evolution,
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(auth.instance.name)}`,
      {
        method: 'POST',
        body: { message: { key: target.row.key, message: downloadPayload(target.media) }, convertToMp4: false },
        timeout: MEDIA_DOWNLOAD_DEADLINE_MS,
        // Stop when the MCP client hangs up; the deadline covers the rest.
        signal: requestAbortSignal(),
      },
      'base64',
      maxBytes,
    )
  }
  catch (error) {
    const status = httpStatusOf(error)
    // Our own cap (the reader's 413) passes through; a 413 Evolution itself
    // answered (a proxy's body limit, say) is the server failing, below.
    if (status === 413 && !(error instanceof MediaFetchError)) throw error
    // The caller hung up: nothing failed on Evolution's side, and nobody is
    // waiting for an answer — not logged as a download failure, nor left to
    // surface as an unhandled error.
    if (requestAbortSignal().aborted) throw callerGone()
    console.error(`[media] WhatsApp download on connection ${auth.instance.id} failed: Evolution answered ${status ?? (error as Error | undefined)?.name ?? 'nothing'}`)
    const said = JSON.stringify((error as { data?: unknown } | undefined)?.data ?? '')
    if (status === 400 && /not of the media type/i.test(said)) {
      // evolution-api-reforged reloads the stored row and unwraps fewer
      // wrappers than this app does (album items, edits: reforged#91); say
      // what it is, not "expired".
      throw createError({
        statusCode: 422,
        message: 'This WhatsApp server cannot download this kind of message (a wrapped one, such as a photo sent as part of an album, or an edited message). Its media is not reachable through this connector yet.',
      })
    }
    if (status === 400) {
      throw createError({
        statusCode: 422,
        message: 'WhatsApp could not provide this file. Old media expires on WhatsApp\'s servers and can only be '
          + 're-fetched while the phone is online and still holds it; check get-connection-status and try again later.',
      })
    }
    throw createError({
      statusCode: 503,
      message: 'The WhatsApp server did not return the file. Check get-connection-status and try again.',
    })
  }

  const { data } = answer
  if (!data?.length) {
    throw createError({ statusCode: 422, message: 'WhatsApp returned no file for this message.' })
  }

  assertFileMatches(auth, target, data)

  return {
    data,
    mimeType: cleanMimeType(answer.fields?.mimetype ?? target.meta.mimeType),
    fileName: target.meta.fileName ?? cleanFileName(answer.fields?.fileName),
  }
}

/**
 * Refuse bytes that are not this message's file. WhatsApp records the SHA-256
 * of the decrypted file on the message (`fileSha256`), so a server that
 * downloaded another message's file — evolution-api-reforged before 3.3.2
 * reloads by `key.id` alone — is caught here, whichever chat it came from, and
 * nothing is returned (409). A message without a readable hash is not checked:
 * stock 2.3.7 and reforged 3.3.2 download this row's own file anyway.
 */
function assertFileMatches(auth: WhatsappAuth, target: WhatsappMediaTarget, data: Buffer): void {
  const expected = bytesOf(target.media.node.fileSha256)
  if (!expected || expected.length !== 32) return
  if (createHash('sha256').update(data).digest().equals(expected)) return
  console.error(`[media] WhatsApp download on connection ${auth.instance.id} returned a different file than the message names; refused`)
  throw createError({
    statusCode: 409,
    message: 'The WhatsApp server returned a different file than this message carries (another message shares its id), '
      + 'so nothing was returned. Updating Evolution to evolution-api-reforged 3.3.2 or later fixes this.',
  })
}

/**
 * A byte field of a stored WhatsApp payload, in the shapes Evolution writes it:
 * a `Uint8Array` serialised as an index-keyed object (`{"0": 12, "1": 34, …}`),
 * Baileys' `BufferJSON` form (`{ type: 'Buffer', data: [...] }`), a plain array
 * of bytes, or base64. Anything else is unknown.
 */
function bytesOf(value: unknown): Buffer | undefined {
  if (typeof value === 'string') {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : undefined
  }
  if (Array.isArray(value)) return byteArray(value)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.type === 'Buffer' && Array.isArray(record.data)) return byteArray(record.data)
    const keys = Object.keys(record)
    if (keys.length > 0 && keys.every(key => /^\d+$/.test(key))) {
      return byteArray(keys.sort((a, b) => Number(a) - Number(b)).map(key => record[key]))
    }
  }
  return undefined
}

function byteArray(values: unknown[]): Buffer | undefined {
  return values.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255)
    ? Buffer.from(values as number[])
    : undefined
}
