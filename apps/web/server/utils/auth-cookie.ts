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
