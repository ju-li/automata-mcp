import { z } from 'zod'
import type { UserFactors } from '~~/server/utils/mfa'

const body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

/**
 * The password step. An account with no second factor is signed in here, as
 * before. One with a factor is not: it gets a short-lived challenge cookie and
 * the list of methods it may answer with, and the session starts only at
 * `login/verify` — see `mfa.ts` for why that is a separate table, not a flag on
 * the session.
 */
export default defineEventHandler(async (event) => {
  const { email, password } = await parseBody(event, body)
  // Counted now, before the await: checking here and recording after
  // checkPassword let a concurrent burst all pass the check. Handed back below
  // unless the password was wrong.
  const attempt = claimPasswordAttempt(event, email)

  let user: Awaited<ReturnType<typeof checkPassword>>
  try {
    user = await checkPassword(email, password)
  }
  catch (cause) {
    // A database outage throws out of checkPassword as 503 and is not counted.
    releasePasswordAttempt(event, email, attempt)
    throw cause
  }
  if (!user) throw authFailed()
  releasePasswordAttempt(event, email, attempt)
  clearLoginFailures(email)

  let factors: UserFactors
  try {
    factors = await userFactors(await appDb(), user.id)
  }
  catch (cause) {
    // Failing open here would sign in a 2FA account on its password alone.
    console.error('[mfa] could not read second factors at sign-in:', cause)
    throw appDbUnavailable(cause)
  }

  if (!hasSecondFactor(factors)) {
    await startSession(event, user.id)
    return { id: user.id, email: user.email }
  }

  await startLoginChallenge(event, user.id)
  return { mfaRequired: true as const, methods: loginMethods(factors) }
})
