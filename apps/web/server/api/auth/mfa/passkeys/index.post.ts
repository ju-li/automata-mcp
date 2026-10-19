import { z } from 'zod'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'

const body = z.object({
  response: z.record(z.string(), z.unknown()),
  name: z.string().trim().max(100).default(''),
})

/**
 * Finish adding a passkey with the browser's response. The password was proved
 * when the options were issued; the registration challenge this spends is what
 * ties the two requests together.
 *
 * First factor: recovery codes and the end of other sessions, as for
 * `totp/confirm`.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { response, name } = await parseBody(event, body)
  const sql = await appDb()

  const result = await sql.begin(async (tx) => {
    await lockUserFactors(tx, user.id)
    const hadFactor = hasSecondFactor(await userFactors(tx, user.id))

    const passkey = await savePasskey(tx, user, response as unknown as RegistrationResponseJSON, name || 'Passkey')
    return { hadFactor, passkey, recoveryCodes: await afterFactorAdded(tx, user.id, hadFactor) }
  })

  if (!result.hadFactor) await endOtherSessions(event, user.id)
  return { passkey: result.passkey, recoveryCodes: result.recoveryCodes }
})
