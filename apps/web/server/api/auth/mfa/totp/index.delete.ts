import { z } from 'zod'

const body = z.object({ currentPassword: z.string().min(1) })

/** Remove the authenticator app. The last factor takes the recovery codes with it. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword } = await parseBody(event, body)
  await requireCurrentPassword(user, currentPassword)

  const sql = await appDb()
  await sql.begin(async (tx) => {
    await lockUserFactors(tx, user.id)
    await tx`DELETE FROM app.totp_credentials WHERE user_id = ${user.id}`
    await afterFactorRemoved(tx, user.id)
  })
  return { ok: true }
})
