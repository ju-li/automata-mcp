import { z } from 'zod'

const body = z.object({
  password: z.string().min(1).max(256),
})

/**
 * The account's two-step verification password, for the pairing waiting on it.
 *
 * Passed straight to the bridge, which hands it to Telegram's SRP check and
 * keeps nothing. It is never logged here: a validation failure names the field,
 * never its value, and a handled error carries no request body.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const { password } = await parseBody(event, body)
  const bridge = telegramBridgeForInstance(instance)
  try {
    return pairingView(await bridge.password(password))
  }
  catch (error) {
    relayBridgeError(error, 'submit the password')
  }
})
