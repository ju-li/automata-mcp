/**
 * Your own second factors, for the profile dialog. Never another user's: there
 * is no admin view of this, by design (see docs/two-factor.md).
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const sql = await appDb()

  const factors = await userFactors(sql, user.id)
  const passkeys = await sql<{ id: string, name: string, created: string, last_used_at?: string }[]>`
    SELECT id, name, created, last_used_at FROM app.webauthn_credentials
    WHERE user_id = ${user.id} ORDER BY created
  `

  return {
    enabled: hasSecondFactor(factors),
    totp: factors.totp,
    passkeys: passkeys.map(p => ({ id: p.id, name: p.name, created: p.created, lastUsed: p.last_used_at })),
    recoveryRemaining: factors.recoveryRemaining,
    // Passkeys are bound to NUXT_PUBLIC_APP_URL; without it they cannot work.
    passkeysAvailable: Boolean(relyingParty()),
  }
})
