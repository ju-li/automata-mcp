// Checks for what keeps URL secrets (reset/verification tokens, invitation
// codes) out of PostHog: app/utils/analyticsPrivacy.ts.
//
//   pnpm test:analytics
//
// Node loads the .ts module directly (type stripping, Node >= 22.18); it
// imports nothing, for this reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRIVACY_OPTIONS, scrubProperties, scrubUrl } from '../app/utils/analyticsPrivacy.ts'

const ORIGIN = 'https://mcp.getautomata.app'

test('feature flags stay off: their request carries the raw first-page URL', () => {
  // posthog-js sends $initial_current_url in the /flags body, which before_send
  // never sees. The app uses no flags.
  assert.equal(PRIVACY_OPTIONS.advanced_disable_flags, true)
})

test('token and code are masked where the initial URL is recorded', () => {
  assert.equal(PRIVACY_OPTIONS.mask_personal_data_properties, true)
  for (const param of ['token', 'code']) {
    assert.ok(PRIVACY_OPTIONS.custom_personal_data_properties.includes(param), param)
  }
})

test('reset and verification links lose their token', () => {
  for (const url of [
    `${ORIGIN}/reset-password?token=abc123`,
    `${ORIGIN}/verify-email?token=abc123#x`,
    '/reset-password?token=abc123',
  ]) {
    const scrubbed = scrubUrl(url, ORIGIN)
    assert.ok(!scrubbed.includes('abc123'), scrubbed)
  }
})

test('an invitation code in the path is replaced, on our origin only', () => {
  assert.equal(scrubUrl(`${ORIGIN}/invite/waorg_secret?x=1`, ORIGIN), `${ORIGIN}/invite/:code`)
  assert.equal(scrubUrl('/invite/waorg_secret', ORIGIN), '/invite/:code')
  // Someone else's site keeps its path (it is not our secret) but loses its query.
  assert.equal(scrubUrl('https://example.com/invite/abc?ref=1', ORIGIN), 'https://example.com/invite/abc')
})

test('initial-URL properties inside $set_once are scrubbed too', () => {
  const props = {
    $current_url: `${ORIGIN}/reset-password?token=abc123`,
    $set_once: {
      $initial_current_url: `${ORIGIN}/invite/waorg_secret`,
      $initial_referrer: `${ORIGIN}/verify-email?token=abc123`,
      $initial_pathname: '/invite/waorg_secret',
    },
    other: 'token=abc123',
  }
  scrubProperties(props, ORIGIN)
  const sent = JSON.stringify({ ...props, other: undefined })
  assert.ok(!sent.includes('abc123'), sent)
  assert.ok(!sent.includes('waorg_secret'), sent)
})
