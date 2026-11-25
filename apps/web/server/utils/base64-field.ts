/**
 * Read one JSON object that carries a file as a base64 string field —
 * Evolution's `getBase64FromMediaMessage` answer — **while it streams**,
 * decoding that field chunk by chunk into a single buffer, and keeping only the
 * small rest of the object as text.
 *
 * Reading the whole body and then parsing it held the file about four times
 * over at its peak (the body's bytes, its text, the parsed base64 string, the
 * decoded file). This holds it once: the decoded bytes, plus one chunk in
 * flight. When the answer's length is known the output is allocated once at
 * the size it implies (never above `maxDecoded`), so there is no final copy;
 * without it (compressed, or no Content-Length) the decoded pieces are joined
 * at the end, briefly about twice the file.
 *
 * No imports, so it can be exercised in plain Node, like `token-bucket.ts`.
 *
 * Assumptions, refused loudly when broken (`Base64FieldError`, reason
 * `malformed`): a flat object, the field occurring once — a second `"<field>":"`
 * key anywhere after it is refused; one nested *before* the real field with
 * none after it cannot be told apart and is read (no supported Evolution
 * answers that way, and a hostile server could send any bytes anyway) — at a
 * point where `"<field>":"` cannot be part of a string (a key); its value is padded base64 in whole groups of four
 * (`=` only at the end), with `\/` as the only escape (JSON's optional one);
 * the rest of the object stays under `maxOther` bytes. Past `maxDecoded`
 * decoded bytes: reason `too-large`.
 */

export class Base64FieldError extends Error {
  readonly reason: 'too-large' | 'malformed'

  constructor(reason: 'too-large' | 'malformed', message: string) {
    super(message)
    this.name = 'Base64FieldError'
    this.reason = reason
  }
}

const QUOTE = 0x22
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/
/** How much of the text before a chunk is kept to find a key split across chunks. */
const TAIL_CHARS = 64

export class Base64FieldReader {
  private readonly marker: RegExp
  private readonly maxDecoded: number
  private readonly maxOther: number
  private inside = false
  private found = false
  /** The object without the field's value, as bytes (decoded as UTF-8 at the end). */
  private readonly other: Buffer[] = []
  private otherBytes = 0
  /** The last bytes of `other`, as latin1 (byte = char), to match a key split across chunks. */
  private tail = ''
  /** Base64 characters not yet decoded: fewer than four. */
  private carry = ''
  /** The previous chunk ended inside the value on a backslash. */
  private pendingEscape = false
  /** Padding seen: nothing but the closing quote may follow. */
  private padded = false
  private out: Buffer | undefined
  private readonly pieces: Buffer[] = []
  private written = 0

  constructor(
    field: string,
    maxDecoded: number,
    /** The decoded size the answer's length implies, when known: the output is allocated once at it. */
    expectedDecoded?: number,
    maxOther = 64 * 1024,
  ) {
    this.maxDecoded = maxDecoded
    this.maxOther = maxOther
    this.marker = new RegExp(`"${field.replace(/[^A-Za-z0-9_]/g, '')}"\\s*:\\s*"`)
    if (expectedDecoded !== undefined && expectedDecoded > 0) {
      this.out = Buffer.allocUnsafe(Math.min(expectedDecoded, maxDecoded))
    }
  }

  push(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let at = 0
    while (at < bytes.length) {
      if (this.inside) {
        const close = bytes.indexOf(QUOTE, at)
        this.decode(bytes.subarray(at, close < 0 ? bytes.length : close))
        if (close < 0) return
        this.finishValue()
        this.inside = false
        this.keep(bytes.subarray(close, close + 1))
        // The tail still holds this field's own key; looking for a second one
        // starts after it.
        this.tail = ''
        at = close + 1
        continue
      }
      const text = this.tail + bytes.toString('latin1', at)
      const match = this.marker.exec(text)
      if (this.found) {
        // The field once only: a second one (or a nested one before it) is not
        // an answer this reader can trust to have read the right file from.
        if (match) throw new Base64FieldError('malformed', 'The answer carries the file field more than once.')
        this.keep(bytes.subarray(at))
        return
      }
      if (!match) {
        this.keep(bytes.subarray(at))
        return
      }
      // Through the value's opening quote, counted in this chunk's bytes (latin1: one char per byte).
      const through = match.index + match[0].length - this.tail.length
      this.keep(bytes.subarray(at, at + through))
      at += through
      this.inside = true
      this.found = true
    }
  }

  /** The rest of the object as JSON text (the field's value empty) and the decoded file, if the field was there. */
  end(): { json: string, data: Buffer | undefined } {
    if (this.inside) throw new Base64FieldError('malformed', 'The answer ended inside the file.')
    const json = Buffer.concat(this.other).toString('utf8')
    if (!this.found) return { json, data: undefined }
    const data = this.out
      ? this.out.subarray(0, this.written)
      : this.pieces.length === 1 ? this.pieces[0]! : Buffer.concat(this.pieces)
    return { json, data }
  }

  private keep(bytes: Buffer): void {
    if (bytes.length === 0) return
    this.otherBytes += bytes.length
    if (this.otherBytes > this.maxOther) {
      throw new Base64FieldError('malformed', 'The answer carries more than a file and its description.')
    }
    this.other.push(Buffer.from(bytes))
    this.tail = (this.tail + bytes.toString('latin1')).slice(-TAIL_CHARS)
  }

  private decode(part: Buffer): void {
    if (part.length === 0) return
    let text = (this.pendingEscape ? '\\' : '') + part.toString('latin1')
    // Evolution does not escape `/`, so most chunks hold no backslash at all:
    // only those pay for the escape handling below.
    if (this.pendingEscape || part.includes(0x5C)) {
      // An odd run of backslashes at the end: the last one escapes what the next chunk starts with.
      let trailing = 0
      while (trailing < text.length && text[text.length - 1 - trailing] === '\\') trailing++
      this.pendingEscape = trailing % 2 === 1
      if (this.pendingEscape) text = text.slice(0, -1)
      text = text.replace(/\\\//g, '/')
      if (text.includes('\\')) throw new Base64FieldError('malformed', 'The file\'s base64 holds an unexpected escape.')
    }
    if (this.padded && text.length > 0) throw new Base64FieldError('malformed', 'The file\'s base64 continues after its padding.')
    text = this.carry + text
    // `=` only at the end of what has arrived so far; a group it completes must end the value.
    if (!BASE64_TEXT.test(text)) throw new Base64FieldError('malformed', 'The file\'s base64 holds characters outside base64.')
    const whole = text.length - (text.length % 4)
    const head = text.slice(0, whole)
    this.carry = text.slice(whole)
    if (head.includes('=')) {
      if (this.carry.length > 0) throw new Base64FieldError('malformed', 'The file\'s base64 continues after its padding.')
      this.padded = true
    }
    if (whole > 0) this.write(Buffer.from(head, 'base64'))
  }

  private finishValue(): void {
    if (this.pendingEscape) throw new Base64FieldError('malformed', 'The file\'s base64 ends on an escape.')
    // Whole, padded groups only (what every base64 encoder Evolution uses
    // writes): a short last group would be decoded leniently, dropping data.
    if (this.carry.length > 0) throw new Base64FieldError('malformed', 'The file\'s base64 does not end in a whole, padded group.')
  }

  private write(bytes: Buffer): void {
    if (this.written + bytes.length > this.maxDecoded) {
      throw new Base64FieldError('too-large', 'The file is larger than this read accepts.')
    }
    if (this.out && this.written + bytes.length > this.out.length) {
      // The answer's length understated the file: keep what is written and go on in pieces.
      this.pieces.push(this.out.subarray(0, this.written))
      this.out = undefined
    }
    if (this.out) bytes.copy(this.out, this.written)
    else this.pieces.push(bytes)
    this.written += bytes.length
  }
}
