// Checks for how the MCP rate limit counts a request (server/utils/mcp-rpc-body.ts)
// and charges it (server/utils/token-bucket.ts).
//
//   pnpm test:rate-limit
//
// Node loads the .ts modules directly (type stripping, Node >= 22.18); neither
// imports anything, for this reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rpcBodyOf } from '../server/utils/mcp-rpc-body.ts'
import { decideBuckets } from '../server/utils/token-bucket.ts'

const call = (id, name = 'list-tables') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

test('a single tools/call is one message and one call', () => {
  const body = rpcBodyOf(JSON.stringify(call(1, 'run-query')))
  assert.equal(body.messages, 1)
  assert.deepEqual(body.calls.map(c => c.name), ['run-query'])
})

test('a JSON-escaped method is still a tool call', () => {
  // "tools\/call" decodes to "tools/call"; the SDK runs it. It must be counted.
  const raw = '{"jsonrpc":"2.0","id":1,"method":"tools\\/call","params":{"name":"run-query","arguments":{}}}'
  assert.ok(!raw.includes('tools/call'))
  const body = rpcBodyOf(raw)
  assert.equal(body.calls.length, 1)
  assert.equal(body.messages, 1)
})

test('every message of a batch counts, tool calls or not', () => {
  const batch = [
    ...Array.from({ length: 500 }, (_, i) => call(i)),
    ...Array.from({ length: 300 }, (_, i) => ({ jsonrpc: '2.0', id: 1000 + i, method: 'tools/list' })),
  ]
  const body = rpcBodyOf(JSON.stringify(batch))
  assert.equal(body.messages, 800)
  assert.equal(body.calls.length, 500)
})

test('unparseable, empty and missing bodies cost one', () => {
  for (const raw of [undefined, '', '{not json', '[]', 'null']) {
    assert.equal(rpcBodyOf(raw).messages, 1, String(raw))
  }
})

test('a cost above capacity is refused, never clamped, and writes nothing', () => {
  const charges = [{ key: 'tok:a', perMinute: 120, cost: 20_000 }]
  const decision = decideBuckets([undefined], charges, Date.now())
  assert.ok(decision.waitMs > 0)
  assert.equal(decision.limiting, 0)
  assert.equal(decision.next, undefined)
})

test('a cost equal to capacity fits a full bucket and empties it', () => {
  const now = Date.now()
  const decision = decideBuckets([undefined], [{ key: 'tok:a', perMinute: 120, cost: 120 }], now)
  assert.equal(decision.waitMs, 0)
  assert.equal(decision.next[0].tokens, 0)
})

test('one oversized bucket refuses the whole charge, all or nothing', () => {
  const charges = [
    { key: 'tok:a', perMinute: 120, cost: 40 },
    { key: 'exp:c', perMinute: 30, cost: 40 },
  ]
  const decision = decideBuckets([undefined, undefined], charges, Date.now())
  assert.ok(decision.waitMs > 0)
  assert.equal(decision.limiting, 1)
  assert.equal(decision.next, undefined)
})
