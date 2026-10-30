/**
 * Where the signup page's marketing box may start ticked, from the visitor's
 * address: `opt-in`, `other` or `unknown`. The cloud service does the lookup
 * and holds the country list (apps/cloud/src/consent-region.ts); the browser
 * never talks to the lookup service itself.
 *
 * Hosted only, reachable signed out. It only ever answers about the caller's
 * own address, so it tells nobody anything they don't know. Every failure is
 * `unknown` rather than an error, and the page then decides from the browser's
 * time zone alone — cloudFetch has already logged the cause.
 */
export default defineEventHandler(async (event) => {
  requireHosted()
  setResponseHeader(event, 'cache-control', 'no-store')

  const ip = clientIp(event)
  if (ip === 'unknown') return { region: 'unknown' }

  const answer = await cloudFetch<{ region?: unknown }>('/consent-region', { method: 'POST', body: { ip }, timeout: 4000 })
    .catch(() => undefined)
  const region = answer?.region === 'opt-in' || answer?.region === 'other' ? answer.region : 'unknown'
  return { region }
})
