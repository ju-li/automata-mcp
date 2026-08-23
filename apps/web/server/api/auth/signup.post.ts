import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  // PocketBase enforces 8 characters minimum; fail here with a useful message
  // rather than surfacing its validation payload.
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(100).optional(),
})

export default defineEventHandler(async (event) => {
  const { email, password, name } = body.parse(await readBody(event))

  const pb = pocketbaseForRequest()

  try {
    await pb.collection('users').create({
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

  await pb.collection('users').authWithPassword(email, password)
  setSessionCookie(event, pb)

  return { id: pb.authStore.record?.id, email: pb.authStore.record?.email }
})
