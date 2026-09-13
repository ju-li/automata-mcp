import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Sealing for the two secrets the bridge stores: a Telegram session string, which
 * is full access to that account, and the headers a webhook is sent with.
 *
 * AES-256-GCM with the row's own identity as additional authenticated data, so a
 * sealed value copied onto another row fails to open rather than logging a
 * different session in. The version prefix is there so the scheme can change
 * without guessing what an old value was sealed with.
 */

const VERSION = 'v1'

/** 32 bytes, as 64 hex characters or as base64. */
export function parseKey(raw: string): Buffer {
  const value = raw.trim()
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (key.length !== 32) {
    throw new Error('must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64')
  }
  return key
}

export function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':')
}

export function unseal(key: Buffer, sealed: string, context: string): string {
  const [version, iv, tag, body] = sealed.split(':')
  if (version !== VERSION || !iv || !tag || !body) throw new Error('unrecognised sealed value')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}

export const sessionContext = (id: string) => `session:${id}`
export const webhookContext = (id: string) => `webhook:${id}`

/** A bearer credential: a recognisable prefix and 32 random bytes. Stored only hashed. */
export function mintKey(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Compare two hex digests without leaking where they differ. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
