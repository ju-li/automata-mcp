import { z } from 'zod'

const body = z.object({ currentPassword: z.string().min(1) })

/** Start adding a passkey or security key: the browser prompt's options. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword } = await parseBody(event, body)
  await requireCurrentPassword(user, currentPassword)

  return await passkeyRegistrationOptions(user)
})
