// Checks for the bounded attempt log behind the sign-in, code and reset caps
// (server/utils/attempt-log.ts): a flood of made-up keys must not flush a
// victim's count, and memory must stay bounded.
//
//   pnpm test:throttle
//
// Node loads the .ts module directly (type stripping, Node >= 22.18); it
// imports nothing, for this reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttemptLog, throttleAddress } from '../server/utils/attempt-log.ts'

const WINDOW = 15 * 60_000
const small = () => new AttemptLog({ windowMs: WINDOW, limit: 10, softCap: 1_000, hardCap: 4_000 })

/** One attempt each on `count` fresh keys, as a spray of made-up addresses would. */
function flood(log, count, now) {
  for (let i = 0; i < count; i++) log.add(`email:junk${i}@example.com`, now)
}

test('a flood of fresh keys does not unblock a blocked account', () => {
  const log = small()
  const t0 = 1_000_000
  for (let i = 0; i < 10; i++) log.add('email:victim@example.com', t0 + i)
  assert.ok(log.blockedUntil('email:victim@example.com', t0 + 100) > 0)

  flood(log, 50_000, t0 + 200)
  assert.ok(log.blockedUntil('email:victim@example.com', t0 + 300) > 0, 'victim key was evicted')
})

test('a flood does not reset a partly spent count either', () => {
  const log = small()
  const t0 = 1_000_000
  for (let i = 0; i < 9; i++) log.add('email:victim@example.com', t0 + i)
  flood(log, 50_000, t0 + 200)
  // One more wrong guess must block: the nine before it still count.
  log.add('email:victim@example.com', t0 + 300)
  assert.ok(log.blockedUntil('email:victim@example.com', t0 + 400) > 0)
})

test('memory stays bounded under a flood', () => {
  const log = small()
  flood(log, 50_000, 1_000_000)
  assert.ok(log.size <= 1_000, `size ${log.size}`)
})

test('past the hard cap even blocked keys go, so memory has a ceiling', () => {
  const log = small()
  const t0 = 1_000_000
  for (let k = 0; k < 6_000; k++) {
    for (let i = 0; i < 10; i++) log.add(`email:blocked${k}@example.com`, t0 + k)
  }
  assert.ok(log.size <= 4_000, `size ${log.size}`)
})

test('the window expires attempts without any sweep', () => {
  const log = small()
  for (let i = 0; i < 10; i++) log.add('ip:203.0.113.9', 0)
  assert.ok(log.blockedUntil('ip:203.0.113.9', WINDOW - 1) > 0)
  assert.equal(log.blockedUntil('ip:203.0.113.9', WINDOW), 0)
})

test('drop hands back one attempt', () => {
  const log = small()
  for (let i = 0; i < 10; i++) log.add('email:a@example.com', 5)
  log.drop('email:a@example.com', 5)
  assert.equal(log.blockedUntil('email:a@example.com', 10), 0)
})

test('an IPv6 client is counted as its /64, whatever the spelling', () => {
  const a = throttleAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
  assert.equal(a, '2001:db8:1:2::/64')
  assert.equal(throttleAddress('2001:db8:1:2::1'), a)
  assert.equal(throttleAddress('2001:0db8:0001:0002:ffff::9'), a)
  assert.notEqual(throttleAddress('2001:db8:1:3::1'), a)
})

test('IPv4, IPv4-mapped and unparseable addresses stay whole', () => {
  assert.equal(throttleAddress('203.0.113.9'), '203.0.113.9')
  assert.equal(throttleAddress('::ffff:203.0.113.9'), '203.0.113.9')
  assert.equal(throttleAddress('unknown'), 'unknown')
  assert.equal(throttleAddress('1:2:3'), '1:2:3')
})
