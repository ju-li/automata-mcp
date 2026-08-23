import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { email, password } = body.parse(await readBody(event))

  // A per-request client: the memoized admin client's auth store must never be
  // overwritten with a visitor's token.
  const pb = pocketbaseForRequest()

  try {
    await pb.collection('users').authWithPassword(email, password)
  } catch {
    throw authFailed()
  }

  setSessionCookie(event, pb)
  return { id: pb.authStore.record?.id, email: pb.authStore.record?.email }
})
