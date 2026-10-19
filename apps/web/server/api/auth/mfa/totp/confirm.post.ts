import { z } from 'zod'

const body = z.object({ code: z.string().trim().min(1).max(20) })

/**
 * Finish adding an authenticator app with a code from it.
 *
 * If this is the account's first factor, two more things happen: ten recovery
 * codes are minted and returned (the only time they are shown), and every
 * other session ends — one opened before 2FA was on must not keep the access
 * 2FA was turned on to deny.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { code } = await parseBody(event, body)
  const sql = await appDb()

  const result = await sql.begin(async (tx) => {
    await lockUserFactors(tx, user.id)
    const hadFactor = hasSecondFactor(await userFactors(tx, user.id))

    if (!await consumeTotpCode(tx, user.id, code.replace(/\s/g, ''), false)) return undefined
    await tx`UPDATE app.totp_credentials SET confirmed_at = now() WHERE user_id = ${user.id}`

    return { hadFactor, recoveryCodes: await afterFactorAdded(tx, user.id, hadFactor) }
  })

  if (!result) {
    throw createError({ statusCode: 400, statusMessage: 'That code does not match. Check the time on your phone and try the next one.' })
  }
  if (!result.hadFactor) await endOtherSessions(event, user.id)
  return { recoveryCodes: result.recoveryCodes }
})
