import type { H3Event } from 'h3'
import { AttemptLog, throttleAddress } from './attempt-log'

/**
 * A cap on failed sign-ins, per email and per client address.
 *
 * scrypt makes each guess slow, not scarce; without this the login form lets
 * anyone try passwords against an admin account for as long as they like. Only
 * failures count. A blocked attempt is refused before the account read and the
 * hash comparison, so it costs nothing.
 *
 * An attempt is counted when it is claimed (`claimPasswordAttempt`), in the same
 * synchronous step as the check, and handed back (`releasePasswordAttempt`) once
 * it turns out not to be a wrong password — a success, or an outage, which is
 * not counted. Checking first and recording after `checkPassword` let a burst
 * arriving together all pass the check before any of them was recorded: the
 * cap held for serial guesses only. Same shape as `claimAuthAttempt` in mfa.ts.
 *
 * Both keys, because each alone leaves a hole: per-address only leaves guessing
 * spread over many addresses unbounded; per-email only lets one address spray
 * every account. The per-email key has a known price — a stranger who knows an
 * address can keep it locked out with ten bad guesses every fifteen minutes.
 * Accepted: that is a nuisance, an unbounded guess rate is a breach.
 *
 * Success clears the email key, never the address key — otherwise an attacker
 * resets their own counter by signing into their own account between guesses.
 *
 * In-memory and per-process, like the invitation mail throttle. A speed bump,
 * not a lockout policy: a restart empties it and N replicas allow N times as
 * many guesses. But **not flushable**: a flood of made-up addresses must not
 * evict a victim's count (it did, oldest key first). `AttemptLog` decides what
 * goes when memory runs short — see attempt-log.ts — and client addresses are
 * counted per IPv6 /64 (`throttleAddress`), since one /64 is unlimited keys.
 */
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_FAILURE_LIMIT = 10

// Built on first use, never at module load: Nitro bundles server/utils into one
// chunk in an order that need not follow imports, so a top-level `new
// AttemptLog` can run before the class exists (TDZ crash at boot, as #287).
let failureLog: AttemptLog | undefined
function failures(): AttemptLog {
  return failureLog ??= new AttemptLog({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_FAILURE_LIMIT,
    softCap: 50_000,
    hardCap: 200_000,
  })
}

/**
 * The client's address. The rightmost `X-Forwarded-For` entry is the one the
 * nearest proxy appended; the leftmost — what h3's `xForwardedFor: true` reads —
 * is whatever the client chose to send, and would make the per-address key free
 * to rotate.
 */
export function clientIp(event: H3Event): string {
  const forwarded = getRequestHeader(event, 'x-forwarded-for')
  const last = forwarded?.split(',').map(part => part.trim()).filter(Boolean).pop()
  return last ?? getRequestIP(event) ?? 'unknown'
}

/** The client address as the throttles here count it: whole for IPv4, its /64 for IPv6. */
function throttleIp(event: H3Event): string {
  return throttleAddress(clientIp(event))
}

/** The 429 every throttle here answers, with `Retry-After` for the time left. */
function throwThrottled(event: H3Event, retryInMs: number, message: string): never {
  setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil(retryInMs / 1000)))
  throw createError({ statusCode: 429, statusMessage: message })
}

function keysFor(event: H3Event, email: string): string[] {
  return [`email:${normaliseEmail(email)}`, `ip:${throttleIp(event)}`]
}

/**
 * Checks both keys and, when neither is at the cap, counts this attempt against
 * both — with no `await` between the two, so concurrent attempts see each
 * other. Throws 429 otherwise. Returns the claim's timestamp, which the caller
 * passes to `releasePasswordAttempt` unless the password turned out wrong.
 */
export function claimPasswordAttempt(event: H3Event, email: string): number {
  const now = Date.now()
  const keys = keysFor(event, email)
  const retryAt = Math.max(...keys.map(key => failures().blockedUntil(key, now)))
  if (retryAt) {
    // One message for both keys: which limit hit would say whether the address
    // has an account behind it.
    throwThrottled(event, retryAt - now, 'Too many failed sign-in attempts. Try again in a few minutes.')
  }

  for (const key of keys) failures().add(key, now)
  return now
}

/**
 * Hands back the attempt claimed at `at`: it was not a wrong password. Removes
 * one entry with that timestamp from each key — entries with equal timestamps
 * are interchangeable, so which one goes does not matter. A claim already
 * pruned or evicted is simply absent.
 */
export function releasePasswordAttempt(event: H3Event, email: string, at: number): void {
  for (const key of keysFor(event, email)) failures().drop(key, at)
}

export function clearLoginFailures(email: string): void {
  failures().delete(`email:${normaliseEmail(email)}`)
}

/**
 * The same cap on wrong signup codes, per client address only — there is no
 * account to key on yet. Shares the map and window with sign-in failures, under
 * its own prefix, so the two never count against each other.
 */
export function assertSignupCodeAllowed(event: H3Event): void {
  const now = Date.now()
  const retryAt = failures().blockedUntil(`signup-ip:${throttleIp(event)}`, now)
  if (!retryAt) return
  throwThrottled(event, retryAt - now, 'Too many wrong signup codes. Try again in a few minutes.')
}

export function recordSignupCodeFailure(event: H3Event): void {
  failures().add(`signup-ip:${throttleIp(event)}`, Date.now())
}

/**
 * The same cap on wrong email-verification codes, per address being verified
 * and across every pending row for it. Each row allows five guesses, but a new
 * signup for the same address is a new row with five more, and the per-client
 * mail throttle is all that limits minting rows — so neither bound holds alone.
 * Keyed on the address only, for that reason.
 *
 * The price is the per-email login key's: a stranger can keep code entry for an
 * address locked. Only the code — the link in the mail is not throttled here, so
 * the owner still verifies with it. A refused attempt touches no row.
 */
function verifyCodeKey(email: string): string {
  return `verify-email:${normaliseEmail(email)}`
}

export function assertVerifyCodeAllowed(event: H3Event, email: string): void {
  const now = Date.now()
  const retryAt = failures().blockedUntil(verifyCodeKey(email), now)
  if (!retryAt) return
  throwThrottled(event, retryAt - now, 'Too many wrong codes for this address. Use the link in the email, or try again in a few minutes.')
}

export function recordVerifyCodeFailure(email: string): void {
  failures().add(verifyCodeKey(email), Date.now())
}

/**
 * Wrong password-reset codes, capped per address and per client, across every
 * reset row. A right code is an account, so this is tighter than the signup
 * code: ten per fifteen minutes on each key, as everywhere here, and also
 * thirty per day per address. Each row allows five guesses, but asking again
 * mints a new row with five more, and only the mail throttle limits that — so
 * the per-row cap alone bounds nothing. At thirty guesses a day a six-digit code
 * holds for decades rather than months.
 *
 * Keyed on the address whether or not it has an account, and counted for codes
 * that matched no row, so the answer never says which addresses are real. The
 * price is the per-email login key's: a stranger can keep code entry for an
 * address locked. Only the code — the mailed link is not throttled here, so the
 * owner still resets with it. Checked before any row is touched.
 */
const RESET_DAY_MS = 24 * 60 * 60_000
const RESET_DAILY_LIMIT = 30
let resetDailyLog: AttemptLog | undefined
function resetDaily(): AttemptLog {
  return resetDailyLog ??= new AttemptLog({
    windowMs: RESET_DAY_MS,
    limit: RESET_DAILY_LIMIT,
    softCap: 50_000,
    hardCap: 200_000,
  })
}

function resetCodeKeys(event: H3Event, email: string): string[] {
  return [`reset-code:${normaliseEmail(email)}`, `reset-code-ip:${throttleIp(event)}`]
}

export function assertResetCodeAllowed(event: H3Event, email: string): void {
  const now = Date.now()
  const retryAt = Math.max(
    ...resetCodeKeys(event, email).map(key => failures().blockedUntil(key, now)),
    resetDaily().blockedUntil(normaliseEmail(email), now),
  )
  if (retryAt) {
    throwThrottled(event, retryAt - now, 'Too many wrong codes. Use the link in the email, or try again later.')
  }
}

export function recordResetCodeFailure(event: H3Event, email: string): void {
  const now = Date.now()
  for (const key of resetCodeKeys(event, email)) failures().add(key, now)
  resetDaily().add(normaliseEmail(email), now)
}
