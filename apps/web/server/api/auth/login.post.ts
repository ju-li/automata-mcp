import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { email, password } = await parseBody(event, body)
  assertLoginAllowed(event, email)

  // A database outage throws out of checkPassword as 503 and is not counted.
  const user = await checkPassword(email, password)
  if (!user) {
    recordLoginFailure(event, email)
    throw authFailed()
  }
  clearLoginFailures(email)

  await startSession(event, user.id)
  return { id: user.id, email: user.email }
})
