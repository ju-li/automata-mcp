import { z } from 'zod'
import type { AppUser } from '~~/server/utils/app-db'

const body = z.object({
  email: z.string().email().max(200),
  currentPassword: z.string().min(1),
})

/**
 * Change your own email address.
 *
 * The password proof stands in for a confirmation link: invitations are already
 * link-based rather than mail-dependent, and an email change that waited on a
 * mail this deployment may not be able to send would leave the user waiting for
 * a message nobody can deliver.
 *
 * The address is stored through `normaliseEmail()`, the same function invitation
 * acceptance compares against. Getting that wrong would make a pending
 * invitation for `Foo@Bar.com` unmatchable by an account that had just set its
 * address to exactly that.
 *
 * One consequence the person typing cannot see, so it is written down here: an
 * invitation addressed to their **old** address stops being redeemable by this
 * account, and one addressed to the **new** address starts being.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { email, currentPassword } = await parseBody(event, body)

  await requireCurrentPassword(user, currentPassword)

  const next = normaliseEmail(email)
  if (next === normaliseEmail(user.email)) return { email: user.email, reauthenticated: true }

  let updated: AppUser
  try {
    updated = await updateRow<AppUser>('users', user.id, { email: next })
  }
  catch (error) {
    // The body was valid; the world disagreed.
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: 'That email address is already in use' })
    }
    throw error
  }

  return { email: updated.email, reauthenticated: true }
})
