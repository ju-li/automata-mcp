import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Authenticator-app codes: RFC 6238 TOTP over RFC 4226 HOTP, the parameters
 * every app defaults to (HMAC-SHA1, 30-second steps, 6 digits).
 *
 * Hand-rolled on `node:crypto` because the whole algorithm is the function
 * below; a dependency would add surface, not correctness. Checked against the
 * RFC 6238 Appendix B vectors.
 *
 * Pure: no database, no clock beyond the `now` a caller passes. Replay
 * protection — refusing a step already used — needs the stored `last_step`
 * and lives in `mfa.ts`.
 */

const STEP_SECONDS = 30
const DIGITS = 6
/** One step either side, so a phone clock 30 s off still works. */
const WINDOW = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error('Invalid base32 character')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A fresh 160-bit secret, base32 as authenticator apps expect it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS)
}

/**
 * The step a code matches within the window, or `undefined`.
 *
 * Every candidate step is compared, constant-time, whether or not an earlier
 * one already matched, so timing does not say which step was right.
 */
export function matchTotp(secretBase32: string, code: string, now = Date.now()): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined
  const secret = base32Decode(secretBase32)
  const current = totpStep(now)
  let matched: number | undefined
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code)) && matched === undefined) {
      matched = step
    }
  }
  return matched
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}
