import { z } from 'zod'

const body = z.object({
  currentPassword: z.string().min(1),
  // PocketBase enforces 8 characters minimum; fail here with a useful message
  // rather than surfacing its validation payload. Same reasoning as signup.
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

/**
 * Change your own password.
 *
 * Written through the caller's **own** authenticated client, not the superuser
 * one: PocketBase lets a record owner set its password when `oldPassword` comes
 * with it, and `users.updateRule` already permits the write. That is the whole
 * difference from the email route next door, which has no owner-writable path at
 * all without a mailer.
 *
 * `authenticateWithPassword` has already proved `currentPassword`, so passing it
 * again as `oldPassword` is not a second check for us — it is the field
 * PocketBase itself requires before it will accept a non-superuser password
 * write, and leaving it out is a 400 from the backend rather than a bypass.
 *
 * `passwordConfirm` is the same value, not a second input: the "confirm new
 * password" box is a typo guard in the browser and never travels as its own
 * field of truth. A server that trusted a separately-submitted confirmation
 * would be trusting the client to have compared them.
 *
 * This revokes **no connector tokens**, and that is correct rather than an
 * oversight. They are minted by this app, stored only as hashes in `mcp_tokens`,
 * and resolved through the admin client — none of them rides on this user's
 * PocketBase token, so nothing about them is weakened by the password that was
 * just replaced. A leaked connector token is answered by rotating that token. The
 * dialog says so, because "I changed my password" otherwise reads as having
 * closed every door.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword, password } = await parseBody(event, body)

  const pb = await authenticateWithPassword(user.email, currentPassword)

  try {
    await pb.collection('users').update(user.id, {
      oldPassword: currentPassword,
      password,
      passwordConfirm: password,
    })
  }
  catch (error) {
    // The old password is already proved, so a 400 here is PocketBase refusing the
    // *new* one on a rule of its own beyond the 8-character floor.
    if (httpStatusOf(error) === 400) {
      throw createError({
        statusCode: 400,
        statusMessage: 'That password was rejected. Choose a different one.',
      })
    }
    // A 403 here would mean `users.updateRule` is no longer `id = @request.auth.id`
    // (1787430350_init_mcp_auth.js) — a PocketBase that was edited by hand or never
    // migrated. That is an operator fault the user cannot act on, so name it: a
    // handled createError leaves nothing at all in the Nitro log.
    console.error(
      `[account] PocketBase refused a password change for ${user.id}. If this is a 403, check that `
      + 'users.updateRule is still `id = @request.auth.id`.',
      error,
    )
    throw createError({ statusCode: 503, statusMessage: 'Auth backend unavailable', cause: error })
  }

  // That update just invalidated the token `pb` is holding, and the cookie the
  // browser sent. Sign back in with the new password.
  const reauthenticated = await reissueSessionCookie(event, user.email, password, user.id)

  return { ok: true, reauthenticated }
})
