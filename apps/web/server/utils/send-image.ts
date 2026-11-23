import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'

/**
 * The image a send tool (`send-whatsapp-image`, `send-telegram-image`) puts in
 * a message: bytes we hold, checked, never a URL handed on.
 *
 * **We fetch, the backend never does.** Evolution's `sendMedia` and teleproto's
 * `sendFile` both accept a URL and would download it themselves — from inside
 * our private network, where `http://evolution:8080/…`, the cloud metadata
 * address or the bridge's own port are one argument away. A model-chosen URL
 * is as user-supplied as a DSN, so it goes through `assertPublicUrl` like one,
 * and the backend only ever receives bytes.
 *
 * **Pinned, unlike the Evolution client.** `node:http` dials whatever `hostname`
 * it is given, so the request goes to the address the guard approved, with the
 * URL's host as SNI and `Host` — no rebinding window between check and dial
 * (the gap `evolution.ts` documents for `$fetch` does not exist here). Every
 * redirect hop is guarded and pinned again; a fixed hop limit, no cookies.
 *
 * **Bounded end to end.** One deadline covers every hop, headers and body (a
 * server trickling bytes is the same attack as GHSA-g2cf-mx92-xc53), and the
 * body is counted as it arrives — `content-length` is a hint, refused early
 * when it already says too much, never trusted when it says little.
 *
 * **Type decided by the bytes.** Only JPEG and PNG: both backends send them as
 * a photo everywhere. Telegram files anything else (WebP, GIF) as a document
 * or sticker, and stock Evolution 2.3.7 does not convert, so accepting them
 * would mean a send that looks different from what was asked. The server's
 * `content-type` is ignored — a page answering 200 with HTML is refused by its
 * first bytes.
 */

/** Largest image either tool sends. WhatsApp recompresses above this anyway; Telegram's photo limit is 10 MB. */
export const MAX_SEND_IMAGE_BYTES = 5 * 1024 * 1024

/** Hard deadline for fetching an image URL: every hop, headers and body. */
const IMAGE_FETCH_DEADLINE_MS = 20_000

const MAX_REDIRECTS = 3

/**
 * Base64 characters that decode to at most `MAX_SEND_IMAGE_BYTES`, plus room
 * for a `data:` prefix and line breaks. The MCP body cap (2 MiB) is the
 * tighter bound in practice; this one only keeps the schema honest.
 */
const MAX_BASE64_CHARS = Math.ceil(MAX_SEND_IMAGE_BYTES / 3) * 4 + 1024

export type SendImage = {
  bytes: Buffer
  mimeType: 'image/jpeg' | 'image/png'
  extension: 'jpg' | 'png'
}

/** The two image arguments both send tools take — exactly one per call. */
export const sendImageInputSchema = {
  imageUrl: z.string().url().max(2048).optional().describe(
    'Public http(s) URL of a JPEG or PNG image (at most 5 MB). It is downloaded by this server, '
    + 'so it must be reachable without signing in.',
  ),
  imageBase64: z.string().min(1).max(MAX_BASE64_CHARS).optional().describe(
    'Instead of imageUrl: the JPEG or PNG file itself, base64-encoded (a data: URL prefix is '
    + 'accepted). Requests are capped at 2 MB, so this suits images up to about 1.5 MB.',
  ),
}

/** Resolve the tool's image argument into checked bytes, or refuse with a message the model can act on. */
export async function loadSendImage(input: { imageUrl?: string, imageBase64?: string }): Promise<SendImage> {
  if (Boolean(input.imageUrl) === Boolean(input.imageBase64)) {
    throw createError({ statusCode: 400, message: 'Pass exactly one of `imageUrl` or `imageBase64`. Nothing was sent.' })
  }
  const bytes = input.imageUrl ? await fetchImage(input.imageUrl) : decodeBase64Image(input.imageBase64!)
  return sniffImage(bytes)
}

function refuse(message: string): never {
  throw createError({ statusCode: 422, message: `${message} Nothing was sent.` })
}

function decodeBase64Image(raw: string): Buffer {
  const body = raw.replace(/^data:[^,]{0,100},/i, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body)) {
    refuse('`imageBase64` is not valid base64.')
  }
  // Checked on the length before decoding, so an oversized argument costs no buffer.
  if (Math.floor(body.length * 3 / 4) > MAX_SEND_IMAGE_BYTES + 2) {
    refuse(`The image is larger than ${formatBytes(MAX_SEND_IMAGE_BYTES)}.`)
  }
  const bytes = Buffer.from(body, body.includes('-') || body.includes('_') ? 'base64url' : 'base64')
  if (bytes.length === 0) refuse('`imageBase64` decodes to nothing.')
  if (bytes.length > MAX_SEND_IMAGE_BYTES) refuse(`The image is larger than ${formatBytes(MAX_SEND_IMAGE_BYTES)}.`)
  return bytes
}

/** First bytes → type. Anything but JPEG or PNG is refused, named where we can name it. */
function sniffImage(bytes: Buffer): SendImage {
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { bytes, mimeType: 'image/jpeg', extension: 'jpg' }
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { bytes, mimeType: 'image/png', extension: 'png' }
  }
  const found = bytes.subarray(0, 6).toString('latin1').startsWith('GIF8')
    ? 'a GIF'
    : bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      ? 'a WebP image'
      : /^\s*</.test(bytes.subarray(0, 64).toString('latin1'))
        ? 'an HTML or XML page, not an image'
        : 'not a JPEG or PNG image'
  refuse(`That file is ${found}. Only JPEG and PNG images can be sent.`)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

async function fetchImage(rawUrl: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(IMAGE_FETCH_DEADLINE_MS)
  let url = new URL(rawUrl)
  for (let hop = 0; ; hop++) {
    const response = await getPinned(url, signal)
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume()
      if (hop >= MAX_REDIRECTS) refuse(`The image URL redirected more than ${MAX_REDIRECTS} times.`)
      try {
        url = new URL(response.headers.location, url)
      }
      catch {
        refuse('The image URL redirected to an invalid address.')
      }
      continue
    }
    if (status !== 200) {
      response.resume()
      refuse(`The image URL answered HTTP ${status}${status === 401 || status === 403 ? ' — it needs signing in, so this server cannot download it' : ''}.`)
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.resume()
      refuse('The image URL answered with a compressed body, which this server does not unpack.')
    }
    return readCapped(response, signal)
  }
}

/** One GET, dialled at the guard-approved address. */
async function getPinned(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  // Guards http(s) only and refuses private and own-infrastructure addresses;
  // its 422 names the URL label.
  const { address } = await assertPublicUrl(url.href, 'Image URL')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const secure = url.protocol === 'https:'
  const request = secure ? httpsRequest : httpRequest

  return await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({
      method: 'GET',
      hostname: address,
      port: Number(url.port) || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      // Certificate checked against the name, not the address we dial.
      ...(secure && !isIP(host) && { servername: host }),
      headers: {
        'host': url.host,
        'accept': 'image/jpeg, image/png',
        'accept-encoding': 'identity',
        'user-agent': 'Automata-ImageFetch/1.0',
      },
      signal,
      agent: false,
    }, resolve)
    req.on('error', (error) => {
      reject(signal.aborted
        ? createError({ statusCode: 422, message: `The image URL did not finish downloading within ${IMAGE_FETCH_DEADLINE_MS / 1000} s. Nothing was sent.` })
        : createError({ statusCode: 422, message: `The image URL could not be reached (${(error as NodeJS.ErrnoException).code ?? error.message}). Nothing was sent.` }))
    })
    req.end()
  })
}

async function readCapped(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_SEND_IMAGE_BYTES) {
    response.destroy()
    refuse(`The image is ${formatBytes(declared)}, over the ${formatBytes(MAX_SEND_IMAGE_BYTES)} limit.`)
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      size += (chunk as Buffer).length
      if (size > MAX_SEND_IMAGE_BYTES) {
        response.destroy()
        refuse(`The image is larger than ${formatBytes(MAX_SEND_IMAGE_BYTES)}.`)
      }
      chunks.push(chunk as Buffer)
    }
  }
  catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error
    refuse(signal.aborted
      ? `The image URL did not finish downloading within ${IMAGE_FETCH_DEADLINE_MS / 1000} s.`
      : 'The image download was cut off.')
  }
  if (size === 0) refuse('The image URL answered with an empty body.')
  return Buffer.concat(chunks, size)
}
