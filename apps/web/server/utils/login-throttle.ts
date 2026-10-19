import type { H3Event } from 'h3'

/**
 * A cap on failed sign-ins, per email and per client address.
 *
 * scrypt makes each guess slow, not scarce; without this the login form lets
 * anyone try passwords against an admin account for as long as they like. Only
 * failures count. A blocked attempt is refused before the account read and the
 * hash comparison, so it costs nothing.
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
 * many guesses.
 */
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_FAILURE_LIMIT = 10
const MAX_TRACKED_KEYS = 10_000

const failures = new Map<string, number[]>()

function prune(now: number): void {
  for (const [key, times] of failures) {
    const recent = times.filter(at => now - at < LOGIN_WINDOW_MS)
    if (recent.length) failures.set(key, recent)
    else failures.delete(key)
  }
  // Insertion order is oldest first; a spray of made-up emails must not grow
  // this without bound.
  for (const key of failures.keys()) {
    if (failures.size <= MAX_TRACKED_KEYS) break
    failures.delete(key)
  }
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

function keysFor(event: H3Event, email: string): string[] {
  return [`email:${normaliseEmail(email)}`, `ip:${clientIp(event)}`]
}

/** Throws 429 if either this email or this address has failed too often. */
export function assertLoginAllowed(event: H3Event, email: string): void {
  const now = Date.now()
  prune(now)

  let retryAt = 0
  for (const key of keysFor(event, email)) {
    const times = failures.get(key) ?? []
    if (times.length >= LOGIN_FAILURE_LIMIT) {
      retryAt = Math.max(retryAt, times[times.length - LOGIN_FAILURE_LIMIT]! + LOGIN_WINDOW_MS)
    }
  }
  if (!retryAt) return

  // One message for both keys: which limit hit would say whether the address
  // has an account behind it.
  setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil((retryAt - now) / 1000)))
  throw createError({
    statusCode: 429,
    statusMessage: 'Too many failed sign-in attempts. Try again in a few minutes.',
  })
}

export function recordLoginFailure(event: H3Event, email: string): void {
  const now = Date.now()
  for (const key of keysFor(event, email)) {
    failures.set(key, [...(failures.get(key) ?? []), now])
  }
}

export function clearLoginFailures(email: string): void {
  failures.delete(`email:${normaliseEmail(email)}`)
}

/**
 * The same cap on wrong signup codes, per client address only — there is no
 * account to key on yet. Shares the map and window with sign-in failures, under
 * its own prefix, so the two never count against each other.
 */
export function assertSignupCodeAllowed(event: H3Event): void {
  const now = Date.now()
  prune(now)

  const times = failures.get(`signup-ip:${clientIp(event)}`) ?? []
  if (times.length < LOGIN_FAILURE_LIMIT) return

  const retryAt = times[times.length - LOGIN_FAILURE_LIMIT]! + LOGIN_WINDOW_MS
  setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil((retryAt - now) / 1000)))
  throw createError({
    statusCode: 429,
    statusMessage: 'Too many wrong signup codes. Try again in a few minutes.',
  })
}

export function recordSignupCodeFailure(event: H3Event): void {
  const key = `signup-ip:${clientIp(event)}`
  failures.set(key, [...(failures.get(key) ?? []), Date.now()])
}
