import type { H3Event } from 'h3'
import type PocketBase from 'pocketbase'

/**
 * Session cookie handling for the browser UI.
 *
 * The cookie is `httpOnly` on purpose: the browser never loads the PocketBase
 * client SDK and never talks to PocketBase directly. Every read and write is
 * brokered by a Nuxt route, so the auth token is not reachable from JS and an
 * XSS cannot walk off with it.
 */
export function setSessionCookie(event: H3Event, pb: PocketBase): void {
  appendResponseHeader(event, 'set-cookie', pb.authStore.exportToCookie({
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'Lax',
    path: '/',
    // Matches PocketBase's own default token lifetime.
    maxAge: 60 * 60 * 24 * 14,
  }, PB_COOKIE))
}

export function clearSessionCookie(event: H3Event): void {
  setCookie(event, PB_COOKIE, '', {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

/**
 * PocketBase reports bad credentials and validation failures as 400. Surface a
 * generic message rather than echoing its payload, which distinguishes "no such
 * email" from "wrong password" and turns login into an account-enumeration
 * oracle.
 */
export function authFailed(): Error {
  return createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
}

/**
 * Prove that the person driving this session typed the account's own password,
 * and hand back a client authenticated as them.
 *
 * Changing an email address or a password is a credential change, and the
 * session cookie alone is a weaker thing than the password: it is `httpOnly`,
 * but a signed-in browser left open is enough to use it. Asking for the current
 * password is what makes "someone walked up to an unlocked laptop" not the same
 * as "someone took the account".
 *
 * The failure is a **403**, never a 401. CLAUDE.md's rule holds here too: a 401
 * tells the client its credential is bad, and the browser reads that as having
 * been signed out — mid-operation, on a request whose cookie was perfectly
 * valid. What was wrong was the password in the form, which is a 403.
 *
 * A PocketBase outage must not become a 403 either, so only its own "these
 * credentials are wrong" answer is translated. `authWithPassword` reports that
 * as 400, exactly as `login.post.ts` sees it. Everything else is ours, not the
 * caller's — unreachable, a 500, or a collection setting they cannot satisfy (a
 * `users` authRule demanding a verified email would answer 403 here, and this
 * deployment has no mailer to verify one with) — and answers 503 the way
 * `getSessionUser` does. Rethrowing the PocketBase error raw would surface its
 * `status` as an arbitrary 4xx instead.
 *
 * Note the brute-force shape, since it is not zero: this is a password oracle on
 * an authenticated route and the app has no rate limiting. It is bounded by
 * needing a valid session cookie for the very account being guessed at — a
 * privilege-escalation step, not an entry point — and by whatever rate limiting
 * PocketBase itself is configured with on `auth-with-password`.
 */
export async function authenticateWithPassword(email: string, password: string): Promise<PocketBase> {
  const pb = pocketbaseForRequest()

  try {
    await pb.collection('users').authWithPassword(email, password)
  }
  catch (error) {
    if (httpStatusOf(error) === 400) {
      throw createError({ statusCode: 403, statusMessage: 'Current password is incorrect' })
    }
    // A handled createError is invisible to Nitro, so an operator would otherwise
    // get a 503 with nothing whatsoever in the log.
    console.error('[account] PocketBase refused a password check for a reason other than the password', error)
    throw createError({ statusCode: 503, statusMessage: 'Auth backend unavailable', cause: error })
  }

  return pb
}

/**
 * Hand the browser a cookie that still works after a credential change.
 *
 * Changing an auth record's email or password rotates its `tokenKey`, which
 * invalidates every token ever issued for that record — including the cookie the
 * request doing the changing arrived with. Without this the write succeeds and
 * the user is silently signed out on their next navigation, which reads as the
 * change having broken their account.
 *
 * Verified for both paths against PocketBase 0.39.11: replaying the cookie
 * captured before an email change answers `{"user": null}`, so this is
 * load-bearing on the email route and not only on the password one.
 *
 * Returns whether it worked instead of throwing. By the time this runs the
 * credential change has already been committed, so failing the request would
 * report "nothing happened" about something that did happen. The caller passes
 * the answer on so the UI can say "signed out, sign in again" rather than
 * leaving the user to discover it on their next click.
 */
export async function reissueSessionCookie(
  event: H3Event,
  email: string,
  password: string,
  userId: string,
): Promise<boolean> {
  try {
    const pb = pocketbaseForRequest()
    await pb.collection('users').authWithPassword(email, password)
    setSessionCookie(event, pb)
    return true
  }
  catch (error) {
    // The account is changed and its session is dead — the one genuinely bad
    // outcome on these routes, and invisible to Nitro because nothing throws.
    console.error(`[account] credential change for ${userId} succeeded but the session could not be re-issued`, error)
    clearSessionCookie(event)
    return false
  }
}
