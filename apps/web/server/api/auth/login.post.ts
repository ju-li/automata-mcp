import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { email, password } = await parseBody(event, body)

  const user = await checkPassword(email, password)
  if (!user) throw authFailed()

  await startSession(event, user.id)
  return { id: user.id, email: user.email }
})
