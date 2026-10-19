/**
 * The passkey prompt for the second step of signing in. Asked for when the
 * person chooses "Use a passkey", not up front, so an account with only an
 * authenticator app never gets a browser prompt it cannot answer.
 */
export default defineEventHandler(async (event) => {
  const challenge = await resolveLoginChallenge(event)
  if (!challenge) {
    clearLoginChallengeCookie(event)
    throw loginChallengeExpired()
  }
  return await passkeyLoginOptions(challenge)
})
