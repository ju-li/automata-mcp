import { z } from 'zod'

const body = z.object({ currentPassword: z.string().min(1) })

/** Ten new recovery codes, replacing every old one — used or not. Shown once. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword } = await parseBody(event, body)
  await requireCurrentPassword(user, currentPassword)

  const sql = await appDb()
  const recoveryCodes = await sql.begin(async (tx) => {
    await lockUserFactors(tx, user.id)
    if (!hasSecondFactor(await userFactors(tx, user.id))) return undefined
    return await mintRecoveryCodes(tx, user.id)
  })
  if (!recoveryCodes) {
    throw createError({ statusCode: 409, statusMessage: 'Turn on two-factor authentication first' })
  }
  return { recoveryCodes }
})
