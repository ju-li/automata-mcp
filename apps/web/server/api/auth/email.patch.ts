import { z } from 'zod'
import type { AppUser } from '~~/server/utils/pocketbase'

const body = z.object({
  email: z.string().email().max(200),
  currentPassword: z.string().min(1),
})

/**
 * Change your own email address.
 *
 * **Written with the superuser client, and that is not laziness.** PocketBase
 * lets only a superuser set an auth record's email directly; the path open to
 * the record itself is `requestEmailChange` → `confirmEmailChange`, which is
 * confirmation-by-email with no toggle to skip it. This deployment has no SMTP —
 * the same fact that makes invitations link-based rather than emailed
 * (`services/pocketbase/pb_migrations/1787470000_organizations.js:113`) — so
 * that flow would accept the request and then deliver nothing, leaving the user
 * waiting for a message no one can send. The password proof above is what stands
 * in for the confirmation link.
 *
 * The address is stored through `normaliseEmail()`, the same function invitation
 * acceptance compares against. Getting that wrong would make a pending
 * invitation for `Foo@Bar.com` unmatchable by an account that had just set its
 * address to exactly that.
 *
 * Two consequences the person typing cannot see, so they are written down here:
 * an invitation addressed to their **old** address stops being redeemable by
 * this account, and one addressed to the **new** address starts being. And
 * `verified` is left alone — nothing in this app reads it and there is no mailer
 * to verify with, so flipping it would be bookkeeping for an audience of nobody.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { email, currentPassword } = await parseBody(event, body)

  await authenticateWithPassword(user.email, currentPassword)

  const next = normaliseEmail(email)
  // Nothing to write, so nothing invalidated the cookie either — the shape has to
  // match the changed path, or a client reading `reauthenticated` sees `undefined`
  // and concludes the session died.
  if (next === normaliseEmail(user.email)) return { email: user.email, reauthenticated: true }

  const admin = await pocketbaseAdmin()
  let updated: AppUser
  try {
    updated = await admin.collection('users').update<AppUser>(user.id, { email: next })
  }
  catch (error) {
    // 400 from PocketBase here is the address already being registered. Answer
    // 409 rather than passing the 400 through: the body was valid, the world
    // disagreed. Anything that is not a 400 falls through to the 503 below, so an
    // outage never arrives dressed as "already in use".
    if (httpStatusOf(error) === 400) {
      throw createError({ statusCode: 409, statusMessage: 'That email address is already in use' })
    }
    // Not the user's to fix, and invisible to Nitro unless it is logged here.
    console.error(`[account] PocketBase refused an email change for ${user.id}`, error)
    throw createError({ statusCode: 503, statusMessage: 'Auth backend unavailable', cause: error })
  }

  const reauthenticated = await reissueSessionCookie(event, next, currentPassword, user.id)

  return { email: updated.email, reauthenticated }
})
