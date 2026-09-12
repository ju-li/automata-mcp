import { z } from 'zod'
import type { AppUser } from '~~/server/utils/pocketbase'

const body = z.object({
  email: z.string().email(),
  // PocketBase enforces 8 characters minimum; fail here with a useful message
  // rather than surfacing its validation payload.
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(100).optional(),
})

/**
 * Sign up, and land in an organization.
 *
 * The account is created through the **admin** client. `users.createRule` is
 * null as of the organizations migration — nothing outside this handler may
 * create an account — which is what makes "every user has a membership" an
 * invariant rather than a hope. A user with no organization can do nothing at
 * all, and lazily creating one for whoever turns up without one would hand a
 * free organization to anyone who could reach PocketBase, and silently
 * resurrect a user an admin had just removed.
 *
 * The organization is created second and compensated on failure, the same idiom
 * `provisionWhatsappInstance` uses across Evolution and PocketBase: two writes
 * with no transaction between them, so the one that can be undone is the one
 * that goes first.
 *
 * `authWithPassword` runs on a fresh per-request client, never the admin one —
 * its auth store must not be clobbered by a visitor's session.
 */
export default defineEventHandler(async (event) => {
  const { email, password, name } = await parseBody(event, body)

  const admin = await pocketbaseAdmin()

  let created: AppUser
  try {
    created = await admin.collection('users').create<AppUser>({
      email,
      password,
      passwordConfirm: password,
      name: name?.trim() || email.split('@')[0],
    })
  } catch (error) {
    // 400 here is a duplicate email or a rejected password. Both are the user's
    // to fix, so say so without leaking which.
    if ((error as { status?: number })?.status === 400) {
      throw createError({
        statusCode: 400,
        statusMessage: 'That email is already registered, or the password was rejected',
      })
    }
    throw error
  }

  try {
    await createOrganizationFor(created)
  } catch (error) {
    // An account with no organization is a dead end the user cannot fix and an
    // email address they can never register again. Undo it.
    await admin.collection('users').delete(created.id).catch(() => {})
    console.error('[signup] could not create an organization; the account was rolled back', error)
    throw error
  }

  const pb = pocketbaseForRequest()
  await pb.collection('users').authWithPassword(email, password)
  setSessionCookie(event, pb)

  return { id: pb.authStore.record?.id, email: pb.authStore.record?.email }
})
