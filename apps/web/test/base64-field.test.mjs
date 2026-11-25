// Checks for the streaming base64 field decoder behind WhatsApp media downloads
// (server/utils/base64-field.ts): Evolution answers getBase64FromMediaMessage
// with the whole file as base64 in one JSON object, and the app decodes it as it
// streams so the file is held once.
//
//   pnpm test:media
//
// Node loads the .ts module directly (type stripping, Node >= 22.18); it imports
// nothing, for this reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Base64FieldError, Base64FieldReader } from '../server/utils/base64-field.ts'

/** A deterministic PRNG, so a failing case can be replayed from its seed. */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** Split `bytes` into random chunks, including empty ones and single bytes. */
function chunksOf(bytes, random) {
  const out = []
  let at = 0
  while (at < bytes.length) {
    const size = random() < 0.1 ? 0 : 1 + Math.floor(random() * Math.min(bytes.length - at, random() < 0.5 ? 7 : 4096))
    out.push(bytes.subarray(at, at + size))
    at += size
  }
  return out
}

/** Feed `body` in chunks and finish; the reader's answer. */
function read(body, { field = 'base64', max = 1 << 24, expected, random = rng(1) } = {}) {
  const reader = new Base64FieldReader(field, max, expected)
  for (const chunk of chunksOf(Buffer.from(body, 'utf8'), random)) reader.push(new Uint8Array(chunk))
  return reader.end()
}

/** JSON's optional escape of `/`, which Evolution's serialiser may or may not use. */
function escapeSlashes(text) {
  return text.replaceAll('/', '\\/')
}

test('round-trips random files through random chunk splits', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = rng(seed)
    const size = Math.floor(random() * 5000)
    const file = randomBytes(size)
    let b64 = file.toString('base64')
    if (random() < 0.5) b64 = escapeSlashes(b64)
    const before = random() < 0.5 ? '"mediaType":"imageMessage","fileName":"a \\"b\\".jpg",' : ''
    const after = random() < 0.5 ? ',"mimetype":"image/jpeg","size":{"fileLength":"12"}' : ''
    const body = `{${before}"base64":"${b64}"${after}}`
    const expected = random() < 0.5 ? size : undefined

    const { json, data } = read(body, { expected, random })
    assert.ok(data, `seed ${seed}: no data`)
    assert.ok(Buffer.compare(data, file) === 0, `seed ${seed}: decoded bytes differ`)
    const rest = JSON.parse(json)
    if (before) assert.equal(rest.fileName, 'a "b".jpg', `seed ${seed}`)
    if (after) assert.equal(rest.mimetype, 'image/jpeg', `seed ${seed}`)
  }
})

test('an answer without the field has no data and keeps the rest', () => {
  const { json, data } = read('{"mediaType":"imageMessage"}')
  assert.equal(data, undefined)
  assert.equal(JSON.parse(json).mediaType, 'imageMessage')
})

test('more than the cap is refused as too-large', () => {
  const file = randomBytes(1000)
  assert.throws(
    () => read(`{"base64":"${file.toString('base64')}"}`, { max: 999 }),
    error => error instanceof Base64FieldError && error.reason === 'too-large',
  )
  // Exactly at the cap is fine.
  const { data } = read(`{"base64":"${file.toString('base64')}"}`, { max: 1000 })
  assert.equal(data.length, 1000)
})

test('malformed values are refused, never decoded leniently', () => {
  const malformed = [
    '{"base64":"QUJD', // ends inside the value
    '{"base64":"QUJ"}', // a short last group
    '{"base64":"QU=D"}', // padding before the end
    '{"base64":"QUJD!"}', // not base64
    '{"base64":"QUJ\\nD"}', // an escape other than \/
    '{"base64":"QUJD","base64":"QUJD"}', // the field twice
  ]
  for (const body of malformed) {
    assert.throws(
      () => read(body),
      error => error instanceof Base64FieldError && error.reason === 'malformed',
      body,
    )
  }
})
