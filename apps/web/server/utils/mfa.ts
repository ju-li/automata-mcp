import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { Db } from './app-db'

/**
 * Second factors for the web sign-in: authenticator-app codes, passkeys and
 * security keys (`webauthn.ts`), and single-use recovery codes.
 *
 * Browser UI only. Connector tokens are their own credential and nothing here
 * is consulted on the MCP surface.
 *
 * **A row in `app.sessions` means fully signed in.** A sign-in that passed the
 * password and still owes a factor is a row in `app.mfa_challenges` plus a
 * cookie scoped to `/api/auth/login`, and becomes a session only through
 * `finishLoginChallenge()`. So `getSessionUser`, the session middleware and
 * every `requireSessionUser` caller are unchanged — none of them can be handed
 * a half-finished sign-in, because none of them can see one.
 *
 * A challenge allows five wrong answers and is then deleted; the password has
 * to be typed again for another five. That cap is the control. The per-account
 * throttle below is a speed bump on top, as for invitation mail.
 */

export const MFA_COOKIE = 'automata_mfa'
const MFA_COOKIE_PATH = '/api/auth/login'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const MAX_CHALLENGE_ATTEMPTS = 5
const RECOVERY_CODE_COUNT = 10

export interface UserFactors {
  totp: boolean
  passkeys: number
  recoveryRemaining: number
}

export function hasSecondFactor(factors: UserFactors): boolean {
  return factors.totp || factors.passkeys > 0
}

/**
 * Which factors this user has. One definition of "has 2FA" — a confirmed
 * authenticator app or at least one passkey — for login and settings alike.
 * Recovery codes alone are not a factor: they exist only beside one.
 */
export async function userFactors(db: Db, userId: string): Promise<UserFactors> {
  const [row] = await db<{ totp: boolean, passkeys: number, recovery: number }[]>`
    SELECT
      EXISTS (SELECT 1 FROM app.totp_credentials WHERE user_id = ${userId} AND confirmed_at IS NOT NULL) AS totp,
      (SELECT count(*)::int FROM app.webauthn_credentials WHERE user_id = ${userId}) AS passkeys,
      (SELECT count(*)::int FROM app.recovery_codes WHERE user_id = ${userId} AND used_at IS NULL) AS recovery
  `
  return { totp: row!.totp, passkeys: row!.passkeys, recoveryRemaining: row!.recovery }
}

export type LoginMethod = 'totp' | 'webauthn' | 'recovery'

export function loginMethods(factors: UserFactors): LoginMethod[] {
  const methods: LoginMethod[] = []
  if (factors.totp) methods.push('totp')
  if (factors.passkeys > 0) methods.push('webauthn')
  if (factors.recoveryRemaining > 0) methods.push('recovery')
  return methods
}

// ── the sign-in challenge ──────────────────────────────────────────────────

export interface LoginChallenge {
  id: string
  user_id: string
  email: string
  webauthn_challenge?: string
  attempts: number
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Password accepted, factor owed: record that and hand the browser its cookie. */
export async function startLoginChallenge(event: H3Event, userId: string): Promise<void> {
  const sql = await appDb()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)

  await sql`
    INSERT INTO app.mfa_challenges (user_id, purpose, token_hash, expires_at)
    VALUES (${userId}, 'login', ${hashToken(token)}, ${expiresAt})
  `
  void sql`DELETE FROM app.mfa_challenges WHERE user_id = ${userId} AND expires_at < now()`.catch(() => {})

  setCookie(event, MFA_COOKIE, token, { ...authCookieOptions(MFA_COOKIE_PATH), expires: expiresAt })
}

export function clearLoginChallengeCookie(event: H3Event): void {
  setCookie(event, MFA_COOKIE, '', { ...authCookieOptions(MFA_COOKIE_PATH), maxAge: 0 })
}

/**
 * The sign-in this request's challenge cookie belongs to, or `undefined`.
 *
 * Same failure rule as `getSessionUser`: `undefined` only when the read ran and
 * found nothing usable; a database fault is a 503. Answering 401 there would
 * send someone back to the password step in the middle of an outage.
 */
export async function resolveLoginChallenge(event: H3Event): Promise<LoginChallenge | undefined> {
  const token = getCookie(event, MFA_COOKIE)
  if (!token) {
    console.warn('[mfa] second-factor request carried no challenge cookie')
    return undefined
  }

  let row: LoginChallenge | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql<LoginChallenge[]>`
      SELECT c.id, c.user_id, u.email, c.webauthn_challenge, c.attempts
      FROM app.mfa_challenges c JOIN app.users u ON u.id = c.user_id
      WHERE c.token_hash = ${hashToken(token)}
        AND c.purpose = 'login'
        AND c.expires_at > now()
        AND c.attempts < ${MAX_CHALLENGE_ATTEMPTS}
    `
  }
  catch (cause) {
    console.error('[mfa] could not read a sign-in challenge from the app database:', cause)
    throw appDbUnavailable(cause)
  }

  if (!row) console.warn('[mfa] sign-in challenge is unknown, expired or out of attempts')
  return row
}

/** The 401 for a challenge that is gone: start again from the password. */
export function loginChallengeExpired(): Error {
  return createError({
    statusCode: 401,
    statusMessage: 'Your sign-in expired. Enter your password again.',
    data: { code: 'mfa_expired' },
  })
}

/**
 * Count a wrong answer. The fifth deletes the challenge, so the next try needs
 * the password again. The increment is one conditional statement, so two wrong
 * answers in flight cannot both be the fourth.
 */
export async function failLoginChallenge(challenge: LoginChallenge, reason: string): Promise<Error> {
  console.warn(`[mfa] second factor refused for user ${challenge.user_id}: ${reason}`)
  recordAuthFailure(`mfa:${challenge.user_id}`)

  const sql = await appDb()
  const [row] = await sql<{ attempts: number }[]>`
    UPDATE app.mfa_challenges SET attempts = attempts + 1
    WHERE id = ${challenge.id} AND attempts < ${MAX_CHALLENGE_ATTEMPTS}
    RETURNING attempts
  `
  if (!row || row.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    await sql`DELETE FROM app.mfa_challenges WHERE id = ${challenge.id}`
    return loginChallengeExpired()
  }
  return createError({ statusCode: 401, statusMessage: 'That code is not valid', data: { code: 'mfa_invalid' } })
}

/**
 * The factor checked out: the challenge is spent and the session begins. The
 * delete is conditional, so a challenge answered twice at once starts one
 * session, not two.
 */
export async function finishLoginChallenge(event: H3Event, challenge: LoginChallenge): Promise<void> {
  const sql = await appDb()
  const [spent] = await sql`DELETE FROM app.mfa_challenges WHERE id = ${challenge.id} RETURNING id`
  clearLoginChallengeCookie(event)
  if (!spent) throw loginChallengeExpired()
  await startSession(event, challenge.user_id)
}

// ── authenticator app ──────────────────────────────────────────────────────

/**
 * Check a code against the user's confirmed authenticator and spend its step.
 *
 * `last_step` only moves forward, in one conditional `UPDATE`, so a code that
 * was seen — over a shoulder, in a proxy log — cannot be used a second time,
 * and two requests racing with the same code cannot both pass.
 */
export async function consumeTotpCode(db: Db, userId: string, code: string, confirmed = true): Promise<boolean> {
  const [row] = await db<{ secret: string }[]>`
    SELECT secret FROM app.totp_credentials
    WHERE user_id = ${userId} AND (confirmed_at IS NOT NULL) = ${confirmed}
  `
  if (!row) return false

  const step = matchTotp(row.secret, code)
  if (step === undefined) return false

  const [spent] = await db`
    UPDATE app.totp_credentials SET last_step = ${step}
    WHERE user_id = ${userId} AND last_step < ${step}
    RETURNING user_id
  `
  if (!spent) console.warn(`[mfa] authenticator code for user ${userId} was already used`)
  return Boolean(spent)
}

// ── recovery codes ─────────────────────────────────────────────────────────

/** Lower-case, no separators: what is hashed and what a typed code becomes. */
function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, '')
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex')
}

/**
 * Replace this user's recovery codes with ten new ones, returned once. Twelve
 * base32 characters — 60 random bits — shown as `xxxx-xxxx-xxxx`.
 */
export async function mintRecoveryCodes(tx: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 12).toLowerCase()
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
  })
  await tx`DELETE FROM app.recovery_codes WHERE user_id = ${userId}`
  await tx`
    INSERT INTO app.recovery_codes ${tx(codes.map(code => ({ user_id: userId, code_hash: hashRecoveryCode(code) })))}
  `
  return codes
}

/** Spend one recovery code. Conditional on unused, so a code works exactly once. */
export async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  if (normaliseRecoveryCode(code).length !== 12) return false
  const [spent] = await db`
    UPDATE app.recovery_codes SET used_at = now()
    WHERE user_id = ${userId} AND code_hash = ${hashRecoveryCode(code)} AND used_at IS NULL
    RETURNING id
  `
  return Boolean(spent)
}

// ── enrolment bookkeeping ──────────────────────────────────────────────────

/**
 * Serialise factor changes for one user. Two enrolments racing must agree on
 * which one was "the first factor" — that one mints recovery codes — and a
 * removal racing an enrolment must not delete the codes the enrolment needs.
 */
export async function lockUserFactors(tx: Db, userId: string): Promise<void> {
  await tx`SELECT id FROM app.users WHERE id = ${userId} FOR UPDATE`
}

/**
 * After a factor is added, inside the same transaction: the first factor gets
 * recovery codes. Returns them (once), or `undefined` when the user already had
 * a factor and therefore already has codes.
 */
export async function afterFactorAdded(tx: Db, userId: string, hadFactor: boolean): Promise<string[] | undefined> {
  if (hadFactor) return undefined
  return await mintRecoveryCodes(tx, userId)
}

/** After a factor is removed: the last one takes its recovery codes with it. */
export async function afterFactorRemoved(tx: Db, userId: string): Promise<void> {
  if (hasSecondFactor(await userFactors(tx, userId))) return
  await tx`DELETE FROM app.recovery_codes WHERE user_id = ${userId}`
}

// ── throttle ───────────────────────────────────────────────────────────────

/**
 * A crude per-account throttle on failed sign-in steps: ten failures in fifteen
 * minutes and the next attempt is refused for the rest of the window. Keys are
 * `login:<email>` for the password and `mfa:<user id>` for the second step.
 *
 * In-memory and per-process, like the invitation mail throttle. A speed bump,
 * not a security control: a restart empties it and a second replica doubles
 * it. The per-challenge attempt cap is what bounds guessing a code.
 */
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const FAILURE_LIMIT = 10
const failures = new Map<string, number[]>()

function recentFailures(key: string, now: number): number[] {
  const recent = (failures.get(key) ?? []).filter(at => now - at < FAILURE_WINDOW_MS)
  if (recent.length) failures.set(key, recent)
  else failures.delete(key)
  return recent
}

export function assertAuthAttemptAllowed(key: string): void {
  if (recentFailures(key, Date.now()).length >= FAILURE_LIMIT) {
    console.warn(`[mfa] throttled sign-in attempts for ${key.split(':')[0]}`)
    throw createError({ statusCode: 429, statusMessage: 'Too many failed attempts. Try again in a few minutes.' })
  }
}

export function recordAuthFailure(key: string): void {
  const now = Date.now()
  // Prune everything now and then so keys for addresses tried once do not pile up.
  if (failures.size > 10_000) for (const k of failures.keys()) recentFailures(k, now)
  failures.set(key, [...recentFailures(key, now), now])
}
