import { z } from 'zod'
import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import { assertNever } from '#shared/connection'

const body = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: z.string().trim().min(1).max(20) }),
  z.object({ method: z.literal('recovery'), code: z.string().trim().min(1).max(40) }),
  z.object({ method: z.literal('webauthn'), response: z.record(z.string(), z.unknown()) }),
])

/**
 * The second step of signing in: answer the challenge `login.post.ts` issued
 * with an authenticator code, a passkey, or a recovery code. A right answer
 * starts the session; a wrong one counts against the challenge's five.
 */
export default defineEventHandler(async (event) => {
  const input = await parseBody(event, body)

  const challenge = await resolveLoginChallenge(event)
  if (!challenge) {
    clearLoginChallengeCookie(event)
    throw loginChallengeExpired()
  }
  assertAuthAttemptAllowed(`mfa:${challenge.user_id}`)

  const sql = await appDb()
  let failure: string | undefined
  switch (input.method) {
    case 'totp':
      if (!await consumeTotpCode(sql, challenge.user_id, input.code.replace(/\s/g, ''))) {
        failure = 'authenticator code did not match or was already used'
      }
      break
    case 'recovery':
      if (!await consumeRecoveryCode(sql, challenge.user_id, input.code)) {
        failure = 'recovery code did not match or was already used'
      }
      break
    case 'webauthn':
      failure = await checkPasskeyAssertion(challenge, input.response as unknown as AuthenticationResponseJSON)
      break
    default:
      assertNever(input)
  }

  if (failure) throw await failLoginChallenge(challenge, failure)

  await finishLoginChallenge(event, challenge)
  return { id: challenge.user_id, email: challenge.email }
})
