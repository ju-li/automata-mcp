import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { H3Event } from 'h3'
import { assertNever } from '#shared/connection'

/**
 * Media downloads for WhatsApp and Telegram messages: the size caps, the
 * signed-URL format, bounded reads, and the shape of a tool result carrying a
 * file. The per-kind fetching lives in `whatsapp-media.ts` and
 * `telegram-media.ts`.
 *
 * **Nothing is stored.** Bytes are fetched from Evolution or the bridge on each
 * call and handed straight back, the same rule as IMAP attachments. A signed
 * URL holds no bytes either: following it fetches the file again, after the
 * same checks the tool ran.
 *
 * **A signed URL is not a bearer credential.** It is a short-lived claim
 * ("this token may fetch this message's media until T"), and the route still
 * requires the very token it was minted for in the `Authorization` header, then
 * re-checks that token's tool and chat scope. A URL copied out of a transcript
 * is useless without the token; a token without a fresh URL can call the tool.
 *
 * **Memory is bounded before bytes are held.** A sender's reported size is a
 * claim, so Evolution's answer (one JSON body with the whole file as base64) is
 * read through `fetchBase64Media`, which decodes the file as it streams and
 * stops at the cap rather than parsing whatever arrives; the bridge's answer is a byte stream, piped
 * through (`pipeMediaToResponse`) or read capped for an inline result
 * (`readStreamCapped`). At most `MEDIA_DOWNLOADS_IN_FLIGHT` downloads run at
 * once in this process, one per connection (`acquireMediaSlot`), each slot held
 * until its file has been delivered — by link or inline — or the delivery guard
 * cut it off (`deliveryGuard`: deadline, stall, caller gone).
 */

/** How long a signed media URL works. Well under the 15 minutes asked of it. */
export const MEDIA_URL_TTL_SECONDS = 10 * 60

/** Downloads one process runs at once; more are refused with 429, never queued. */
const MEDIA_DOWNLOADS_IN_FLIGHT = 3
/** Downloads one connection runs at once, so one connection cannot hold every slot. */
const MEDIA_DOWNLOADS_PER_CONNECTION = 1
/**
 * Longest a media response may take to reach the caller (a 25 MiB link at
 * about 85 KB/s). Past it the response is cut off and its slot given back: a
 * caller that stops reading must not hold a slot, and the file, for ever.
 */
const MEDIA_DELIVERY_DEADLINE_MS = 5 * 60_000
/** Least a followed link must deliver in every window before it counts as stalled and is cut off (about 2 KB/s). */
const MEDIA_DELIVERY_MIN_BYTES = 64 * 1024
const MEDIA_DELIVERY_WINDOW_MS = 30_000
/** Slice a held buffer is written in, so its delivery is paced and measurable. */
const DELIVERY_SLICE_BYTES = 64 * 1024

/** Image types every MCP client renders. Anything else goes back as an embedded file. */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type MediaKind = 'whatsapp' | 'telegram'

/** The tool whose grant a signed URL of this kind depends on. */
export function mediaToolFor(kind: MediaKind): string {
  switch (kind) {
    case 'whatsapp':
      return 'download-whatsapp-media'
    case 'telegram':
      return 'download-telegram-media'
    default:
      return assertNever(kind, 'media kind')
  }
}

/** The largest file fetched at all. */
export function mediaMaxBytes(): number {
  return positiveNumber(useRuntimeConfig().mediaMaxBytes, 25 * 1024 * 1024)
}

/** The largest file returned inside the tool result; above it, a signed URL. */
export function mediaInlineMaxBytes(): number {
  return Math.min(positiveNumber(useRuntimeConfig().mediaInlineMaxBytes, 5 * 1024 * 1024), mediaMaxBytes())
}

function positiveNumber(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** One downloaded file. */
export interface MediaFile {
  data: Buffer
  mimeType: string
  fileName?: string
}

/** What a caller is told about a file, with or without its bytes. */
export interface MediaMeta {
  /** `image`, `video`, `video-note`, `audio`, `voice`, `document`, `sticker` or `photo`. */
  mediaType: string
  mimeType: string
  fileName?: string
  /** Bytes, when known. Exact once downloaded; the sender's claim before. */
  size?: number
}

/**
 * A MIME type safe to put in a `Content-Type` header and a tool result: anything
 * a sender wrote that does not look like `type/subtype` becomes octet-stream, so
 * a crafted value cannot inject a header. This is syntax only — `text/html`
 * passes; the download route's `attachment`, `nosniff` and sandbox CSP headers
 * are what keep a browser from rendering what it serves.
 */
export function cleanMimeType(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream'
  const base = raw.split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)
    ? base
    : 'application/octet-stream'
}

/**
 * A sender-chosen file name, reduced to something that cannot carry a path or a
 * control character. Made well-formed and clipped by code point, never by UTF-16
 * unit: a split surrogate pair makes `encodeURIComponent` throw.
 */
export function cleanFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const wellFormed = (raw as string & { toWellFormed(): string }).toWellFormed()
  // eslint-disable-next-line no-control-regex
  const name = Array.from(wellFormed.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()).slice(0, 200).join('')
  return name && name !== '.' && name !== '..' ? name : undefined
}

/** The result for a file small enough to return inline. Same shapes as `get-email-attachment`. */
export function mediaInlineResult(meta: Record<string, unknown>, file: MediaFile) {
  const text = { type: 'text' as const, text: JSON.stringify({ ...meta, delivery: 'inline' }, null, 2) }
  if (INLINE_IMAGE.has(file.mimeType)) {
    return { content: [text, { type: 'image' as const, data: file.data.toString('base64'), mimeType: file.mimeType }] }
  }
  return {
    content: [
      text,
      {
        type: 'resource' as const,
        resource: {
          uri: `media:///${rfc5987(file.fileName ?? 'file')}`,
          mimeType: file.mimeType,
          blob: file.data.toString('base64'),
        },
      },
    ],
  }
}

/** The result for a file handed back as a signed URL. */
export function mediaUrlResult(meta: Record<string, unknown>, url: string, expiresAt: Date) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ...meta,
        delivery: 'url',
        url,
        expiresAt: expiresAt.toISOString(),
        howToFetch: 'GET the url with the same Authorization: Bearer header as this MCP connection, '
          + 'before expiresAt. It works only for this connector token, and not for a client that '
          + 'puts the token in the URL path; such a client should ask for delivery: "inline".',
      }, null, 2),
    }],
  }
}

/**
 * Refusal when a link is needed and this deployment cannot make one. `over` is
 * given only when the file is known to be over the inline limit (with its size
 * when that is known), so a small file asked for by link is never called large.
 */
export function signedUrlUnavailable(inlineMax: number, over?: { size?: number }) {
  const missing = mediaLinkBlocker() ?? 'NUXT_PUBLIC_APP_URL'
  if (!loggedLinkBlocker) {
    loggedLinkBlocker = true
    console.error(`[media] signed download links unavailable: ${missing} is not set`)
  }
  return createError({
    statusCode: 501,
    message: over
      ? `This file is ${over.size !== undefined ? `about ${formatBytes(over.size)}, ` : ''}over the ${formatBytes(inlineMax)} returned inline, and this server cannot issue download links (its operator has not set ${missing}).`
      : `This server cannot issue download links (its operator has not set ${missing}).`,
  })
}

let loggedLinkBlocker = false

/**
 * The setting that keeps this deployment from issuing download links, if any.
 * A link needs a public URL to point at. On the hosted offering it also needs
 * `NUXT_MEDIA_URL_SECRET`: the per-process fallback key would make a link minted
 * on one replica a silent 404 on the next, and die with every deploy. A
 * self-hosted single process can live with that, and its docs say so.
 */
export function mediaLinkBlocker(): 'NUXT_PUBLIC_APP_URL' | 'NUXT_MEDIA_URL_SECRET' | undefined {
  const config = useRuntimeConfig()
  if (!String(config.public.appUrl ?? '').trim()) return 'NUXT_PUBLIC_APP_URL'
  if (hostedMode() && !String(config.mediaUrlSecret ?? '')) return 'NUXT_MEDIA_URL_SECRET'
  return undefined
}

// ── bounded work ─────────────────────────────────────────────────────────────

let inFlight = 0
const inFlightByConnection = new Map<string, number>()

/**
 * Take one of this process's few media slots for this connection, or refuse
 * with 429; the caller must call the returned release exactly once. A buffered
 * download holds a file several times over while it is decoded, and a streamed
 * one holds a source connection, so the number in flight is what bounds both,
 * whatever the per-minute budgets allow. One connection gets one slot at a
 * time, so a slow reader on one connection cannot shut every other out.
 */
export function acquireMediaSlot(connectionId: string): () => void {
  if (inFlight >= MEDIA_DOWNLOADS_IN_FLIGHT) {
    throw createError({
      statusCode: 429,
      message: 'Too many file downloads are in progress on this server. Try again in a few seconds.',
    })
  }
  const own = inFlightByConnection.get(connectionId) ?? 0
  if (own >= MEDIA_DOWNLOADS_PER_CONNECTION) {
    throw createError({
      statusCode: 429,
      message: 'Another file download on this connection is still in progress. Try again when it has finished.',
    })
  }
  inFlight++
  inFlightByConnection.set(connectionId, own + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    inFlight--
    const left = (inFlightByConnection.get(connectionId) ?? 1) - 1
    if (left > 0) inFlightByConnection.set(connectionId, left)
    else inFlightByConnection.delete(connectionId)
  }
}

/**
 * Run one download for an inline tool result in a media slot. A failure gives
 * the slot back at once; a result keeps it until the MCP response carrying the
 * file has been sent (`holdUntilDelivered`), so the slots bound the files held
 * by slow callers too. One download per connection, so a second download call
 * in the same JSON-RPC batch is refused (429).
 */
export async function withMediaSlot<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const release = acquireMediaSlot(connectionId)
  let result: T
  try {
    result = await work()
  }
  catch (error) {
    release()
    throw error
  }
  holdUntilDelivered(useEvent(), release)
  return result
}

/**
 * Open a raw byte answer as a stream, without reading it. An error answer is
 * read up to 64 KiB and thrown as `MediaFetchError` (status and parsed body),
 * like `fetchBase64Media`'s.
 */
export async function openMediaStream(
  client: typeof $fetch,
  url: string,
  options: Record<string, unknown>,
): Promise<{ headers: Headers, body: ReadableStream<Uint8Array> }> {
  const response = await client.raw(url, { ...options, responseType: 'stream', ignoreResponseError: true })
  const stream = response._data as ReadableStream<Uint8Array> | undefined
  if (!response.ok) {
    const text = stream ? (await readCapped(stream, 64 * 1024)).text : ''
    throw new MediaFetchError(response.status, safeJson(text))
  }
  if (!stream) throw new MediaFetchError(502, undefined)
  return { headers: response.headers, body: stream }
}

/**
 * A whole stream as one Buffer, refused with 413 the moment it passes
 * `maxBytes`. For inline results only. A source that stops mid-stream is a
 * broken download (502), never a short file.
 */
export async function readStreamCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>
    try {
      step = await reader.read()
    }
    catch {
      throw createError({ statusCode: 502, message: 'The download broke off before the whole file arrived. Try again.' })
    }
    if (step.done) break
    size += step.value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw createError({ statusCode: 413, message: `This file is larger than the ${formatBytes(maxBytes)} this connector fetches.` })
    }
    chunks.push(step.value)
  }
  return Buffer.concat(chunks)
}

/**
 * Send a file to the caller through `stream.pipeline`: backpressure (the source
 * is read only as fast as the caller takes it), a byte cap, and the connection
 * destroyed on any failure — the source breaking off, passing `maxBytes`,
 * missing or passing `expectedBytes` (an exact size, sent as Content-Length),
 * or the delivery guard stopping it (`deliveryGuard`) — so a cut-off file
 * never ends as if it were whole. `body` is the bridge's stream, or a buffer
 * already held (WhatsApp). Resolves to whether the whole file was delivered;
 * the caller holds its media slot until then. Headers must be set before
 * calling.
 */
export async function pipeMediaToResponse(
  event: H3Event,
  body: ReadableStream<Uint8Array> | Buffer,
  maxBytes: number,
  expectedBytes?: number,
): Promise<boolean> {
  const res = event.node.res
  // The cap always holds: a reported size can only lower the limit, never raise it.
  const limit = Math.min(maxBytes, expectedBytes ?? maxBytes)
  let size = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > limit) callback(new Error(`media stream passed ${limit} bytes`))
      else callback(null, chunk)
    },
    flush(callback) {
      if (expectedBytes !== undefined && size !== expectedBytes) callback(new Error(`media stream ended at ${size} of ${expectedBytes} bytes`))
      else callback()
    },
  })
  // A held buffer goes out in slices, each written only once the caller has
  // taken the last, like a stream: one write of the whole file would queue it
  // all at once and leave nothing to pace or to measure progress by.
  const source = Buffer.isBuffer(body)
    ? Readable.from(slices(body, DELIVERY_SLICE_BYTES))
    : Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>)
  const guard = deliveryGuard(event, { stall: true })
  try {
    await pipeline(source, counter, res, { signal: guard.signal })
    return true
  }
  catch {
    if (!res.writableEnded) res.destroy()
    return false
  }
  finally {
    guard.stop()
  }
}

function* slices(data: Buffer, size: number): Generator<Buffer> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
}

/**
 * When a media response must stop: the caller went away, or
 * `MEDIA_DELIVERY_DEADLINE_MS` passed — and, with `stall`, when fewer than
 * `MEDIA_DELIVERY_MIN_BYTES` were taken by the connection in a
 * `MEDIA_DELIVERY_WINDOW_MS` window, so a caller reading a trickle cannot hold
 * its slot, and the file, for the whole deadline.
 *
 * Progress is what the kernel accepted (`bytesWritten` less what Node still
 * queues), never what was handed to Node: a queued write is not delivered.
 * That only measures delivery when writes are paced by backpressure, as
 * `pipeMediaToResponse`'s are; an inline result, which the MCP toolkit writes
 * in one go after the tool returns (and after any slower call in the same
 * batch), gets the deadline and the disconnect only. `stop()` clears the timers.
 */
function deliveryGuard(event: H3Event, { stall }: { stall: boolean }): { signal: AbortSignal, stop: () => void } {
  const res = event.node.res
  const cut = new AbortController()
  const accepted = () => (res.socket?.bytesWritten ?? 0) - (res.socket?.writableLength ?? 0)
  let mark = accepted()
  const window = stall
    ? setInterval(() => {
        const now = accepted()
        if (now - mark < MEDIA_DELIVERY_MIN_BYTES) cut.abort(new Error('media delivery stalled'))
        mark = now
      }, MEDIA_DELIVERY_WINDOW_MS)
    : undefined
  const deadline = setTimeout(() => cut.abort(new Error('media delivery deadline passed')), MEDIA_DELIVERY_DEADLINE_MS)
  window?.unref?.()
  deadline.unref?.()
  return {
    signal: AbortSignal.any([requestAbortSignal(event), cut.signal]),
    stop: () => {
      clearInterval(window)
      clearTimeout(deadline)
    },
  }
}

/**
 * Keep a slot until this request's response has been sent — for an inline
 * result, whose file sits in the MCP response the toolkit writes after the tool
 * returns. A response that outlives the deadline is destroyed (no stall check:
 * see `deliveryGuard`), and the slot comes back either way.
 */
function holdUntilDelivered(event: H3Event, release: () => void): void {
  const res = event.node.res
  if (res.closed || res.destroyed) {
    release()
    return
  }
  const guard = deliveryGuard(event, { stall: false })
  const onStop = () => res.destroy()
  guard.signal.addEventListener('abort', onStop, { once: true })
  res.once('close', () => {
    guard.signal.removeEventListener('abort', onStop)
    guard.stop()
    release()
  })
}

/**
 * The JSON body that carries a file of at most `maxBytes`, base64-encoded, plus
 * room for the fields around it. Anything longer cannot be within the cap.
 */
export function cappedBodyBytes(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4 + 256 * 1024
}

/** Shape of an HTTP failure as `httpStatusOf` and `relayBridgeError` read it (like ofetch's). */
export class MediaFetchError extends Error {
  constructor(public status: number, public data: unknown) {
    super(`media fetch answered ${status}`)
    this.name = 'MediaFetchError'
  }
}

/**
 * GET or POST through an ofetch client and read the JSON answer that carries
 * one file of at most `maxFileBytes` as a base64 field named `field`, decoding
 * that field **as it streams** (`Base64FieldReader`): the file is held once,
 * decoded, never also as the answer's bytes, its text and its base64 string.
 * Answers the rest of the object, parsed, and the file (undefined when the
 * field is absent).
 *
 * Bounded before bytes are held: an answer longer than the file's base64 plus
 * room for the fields around it (`cappedBodyBytes`) — by its Content-Length,
 * or by the count as it streams — and a decoded file past `maxFileBytes` are
 * refused with 413, the stream cancelled. An answer that is not the expected
 * shape is a plain error (callers report it as the server failing).
 *
 * An error answer is read up to 64 KiB and the rest dropped — a long error page
 * is still an error, not an oversized file — then thrown as `MediaFetchError`,
 * carrying the status and parsed body the callers' error mapping expects.
 */
export async function fetchBase64Media<T>(
  client: typeof $fetch,
  url: string,
  options: Record<string, unknown>,
  field: string,
  maxFileBytes: number,
): Promise<{ fields: T | null, data: Buffer | undefined }> {
  const response = await client.raw(url, { ...options, responseType: 'stream', ignoreResponseError: true })
  const stream = response._data as ReadableStream<Uint8Array> | undefined
  if (!response.ok) {
    const text = stream ? (await readCapped(stream, 64 * 1024)).text : ''
    throw new MediaFetchError(response.status, safeJson(text))
  }
  const tooLarge = () => createError({ statusCode: 413, message: `This file is larger than the ${formatBytes(maxFileBytes)} this connector fetches.` })
  if (!stream) return { fields: null, data: undefined }

  const bodyLimit = cappedBodyBytes(maxFileBytes)
  const declared = Number(response.headers.get('content-length') ?? '')
  const known = Number.isSafeInteger(declared) && declared > 0
  if (known && declared > bodyLimit) {
    await stream.cancel().catch(() => {})
    throw tooLarge()
  }
  // Content-Length sizes the output only for an uncompressed answer: compressed,
  // it counts the compressed bytes, not the base64 this reads after decoding.
  const sized = known && !response.headers.get('content-encoding')
  const reader = new Base64FieldReader(field, maxFileBytes, sized ? Math.floor(declared * 3 / 4) : undefined)
  const source = stream.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await source.read()
      if (done) break
      size += value.byteLength
      if (size > bodyLimit) throw tooLarge()
      reader.push(value)
    }
    const { json, data } = reader.end()
    return { fields: JSON.parse(json) as T | null, data }
  }
  catch (error) {
    await source.cancel().catch(() => {})
    if (error instanceof Base64FieldError && error.reason === 'too-large') throw tooLarge()
    throw error
  }
}

/** At most `limit` bytes of a stream as text; past it, the stream is cancelled and `truncated` set. */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string, truncated: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size))
      await reader.cancel().catch(() => {})
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true }
    }
    size += value.byteLength
    chunks.push(value)
  }
  const whole = Buffer.concat(chunks)
  chunks.length = 0
  return { text: whole.toString('utf8'), truncated: false }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

// ── signed URLs ──────────────────────────────────────────────────────────────

/** What a signed URL claims. Short keys: it rides in a URL path. */
export interface MediaRef {
  v: 1
  /** Connection kind. */
  k: MediaKind
  /** Connection (instance) id. */
  i: string
  /** Token id the URL was minted for; only that token may follow it. */
  t: string
  /** Chat: a WhatsApp JID, or a Telegram marked chat id. */
  c: string
  /** Message id: WhatsApp's key id, or Telegram's numeric id as a string. */
  m: string
  /** Expiry, unix seconds. */
  e: number
}

/** Used when NUXT_MEDIA_URL_SECRET is unset: links then die with the process. */
const processKey = randomBytes(32)

/**
 * The key that seals media URLs. From `NUXT_MEDIA_URL_SECRET` when set (needed
 * for links to survive a restart or work across replicas), else a random key
 * per process. Never derived from the webhook secret: that one is handed to
 * every Evolution server and bridge, bring-your-own ones included.
 */
function sealingKey(): Buffer {
  const secret = String(useRuntimeConfig().mediaUrlSecret ?? '')
  return secret ? createHmac('sha256', secret).update('automata:media-url:v1').digest() : processKey
}

/**
 * An absolute signed URL for one message's media, or undefined when this
 * deployment cannot issue links (`mediaLinkBlocker`).
 *
 * The claim is **encrypted**, not only signed (AES-256-GCM): the chat id is a
 * phone number, and proxies log paths this app cannot redact.
 */
export function signMediaUrl(ref: Omit<MediaRef, 'v' | 'e'>, now = Date.now()): { url: string, expiresAt: Date } | undefined {
  if (mediaLinkBlocker()) return undefined
  const appUrl = String(useRuntimeConfig().public.appUrl ?? '').trim().replace(/\/+$/, '')

  const expiresAt = new Date(now + MEDIA_URL_TTL_SECONDS * 1000)
  const full: MediaRef = { v: 1, ...ref, e: Math.floor(expiresAt.getTime() / 1000) }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(full), 'utf8'), cipher.final()])
  const blob = Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url')
  return { url: `${appUrl}${MEDIA_ROUTE_PREFIX}${blob}`, expiresAt }
}

export type MediaRefCheck =
  | { ok: true, ref: MediaRef }
  | { ok: false, reason: 'invalid' }
  /** Genuine (it opened) but past its expiry: the ref, so the route can tell only its own token. */
  | { ok: false, reason: 'expired', ref: MediaRef }

/** Open a sealed blob: authenticated decryption, then shape, then expiry. */
export function verifyMediaRef(blob: string | undefined, now = Date.now()): MediaRefCheck {
  if (!blob || blob.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(blob)) return { ok: false, reason: 'invalid' }
  const raw = Buffer.from(blob, 'base64url')
  if (raw.length < 12 + 16 + 2) return { ok: false, reason: 'invalid' }

  let ref: MediaRef
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
    ref = JSON.parse(plain.toString('utf8')) as MediaRef
  }
  catch {
    return { ok: false, reason: 'invalid' }
  }
  if (ref?.v !== 1 || (ref.k !== 'whatsapp' && ref.k !== 'telegram')
    || typeof ref.i !== 'string' || typeof ref.t !== 'string' || typeof ref.c !== 'string'
    || typeof ref.m !== 'string' || typeof ref.e !== 'number') {
    return { ok: false, reason: 'invalid' }
  }
  if (ref.e * 1000 <= now) return { ok: false, reason: 'expired', ref }
  return { ok: true, ref }
}

/** `Content-Disposition` for a download, with the name in both plain and RFC 5987 form. */
export function attachmentDisposition(fileName: string | undefined): string {
  if (!fileName) return 'attachment'
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(fileName)}`
}

/** `encodeURIComponent` plus the four characters RFC 5987 does not allow bare. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}
