import { createHash, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

/**
 * Who may create an account without an invitation.
 *
 * An invitation always works — it names one address and joins an existing
 * organization, so this module never sees it. Everything else creates a new
 * organization, whose admin can start connections on this deployment's
 * Evolution server and Telegram bridge and, with `NUXT_ALLOW_PRIVATE_TARGETS`,
 * point the server at hosts on its private network. That is what this gates.
 *
 * `NUXT_SIGNUP` is `open` or `invite-only`, default `invite-only`; anything
 * else is read as `invite-only`, since a typo must not open the door. In
 * invite-only mode:
 *
 * - `NUXT_SIGNUP_CODE` set: a self-signup must present it. **The first account
 *   too** — otherwise whoever finds a fresh public install before the operator
 *   becomes its admin.
 * - unset: only the first account on an empty database gets through, so a new
 *   deployment can still be set up with no configuration. Decided inside the
 *   signup transaction under an advisory lock (`claimFirstAccount`), so two
 *   racing first signups cannot both win.
 */
export type SignupMode = 'open' | 'invite-only'

/** What the signup page should offer. Never carries the code itself. */
export type SelfSignup = 'open' | 'code' | 'closed'

/** `pg_advisory_xact_lock` key for the first-account check. Arbitrary, fixed. */
const FIRST_ACCOUNT_LOCK = '7204118533901245'

let warnedMode = false

export function signupMode(): SignupMode {
  const value = String(useRuntimeConfig().signup ?? '').trim().toLowerCase()
  if (value === 'open') return 'open'
  if (value && value !== 'invite-only' && !warnedMode) {
    warnedMode = true
    console.warn(`[signup] NUXT_SIGNUP=${value} is not "open" or "invite-only"; treating it as invite-only.`)
  }
  return 'invite-only'
}

function configuredCode(): string {
  return String(useRuntimeConfig().signupCode ?? '').trim()
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Hashed both sides so the comparison is constant-time whatever the lengths. */
function codeMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented.trim()), sha256(expected))
}

async function anyUserExists(db: Db): Promise<boolean> {
  const [row] = await db<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM app.users) AS exists`
  return Boolean(row?.exists)
}

export function signupClosed(): Error {
  return createError({ statusCode: 403, statusMessage: 'Sign-up is by invitation only.' })
}

/**
 * For the signup page. `closed` reads as `open` while the database holds no
 * account, so a fresh install shows the form its first user needs.
 */
export async function selfSignupPolicy(): Promise<SelfSignup> {
  if (signupMode() === 'open') return 'open'
  if (configuredCode()) return 'code'
  try {
    return await anyUserExists(await appDb()) ? 'closed' : 'open'
  }
  catch (cause) {
    console.error('[signup] could not read whether any account exists:', cause)
    throw appDbUnavailable(cause)
  }
}

/**
 * Checks a self-signup (no invitation) before anything is written. Returns
 * whether the caller must still `claimFirstAccount` inside its transaction —
 * true only in invite-only mode with no code configured.
 */
export function checkSelfSignup(event: H3Event, presented: string | undefined): { firstAccountOnly: boolean } {
  if (signupMode() === 'open') return { firstAccountOnly: false }

  const expected = configuredCode()
  if (!expected) return { firstAccountOnly: true }

  assertSignupCodeAllowed(event)
  if (!presented || !codeMatches(presented, expected)) {
    recordSignupCodeFailure(event)
    // A handled 403 is not logged by Nitro; an operator asking why someone
    // could not sign up needs this line.
    console.warn(`[signup] refused a self-signup: ${presented ? 'wrong' : 'no'} signup code`)
    throw signupClosed()
  }
  return { firstAccountOnly: false }
}

/**
 * Inside the signup transaction: refuses unless this is the first account. The
 * lock is held until the transaction ends, so a concurrent first signup waits,
 * then sees this one's row and is refused.
 */
export async function claimFirstAccount(tx: Db): Promise<void> {
  let taken: boolean
  try {
    await tx`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK}::bigint)`
    taken = await anyUserExists(tx)
  }
  catch (cause) {
    console.error('[signup] could not check for an existing account:', cause)
    throw appDbUnavailable(cause)
  }
  if (taken) {
    console.warn('[signup] refused a self-signup: invite-only and accounts already exist')
    throw signupClosed()
  }
}
