import { z } from 'zod'

const body = z.object({
  currentPassword: z.string().min(1),
})

/**
 * Delete your own account — and, when you are its only member, your
 * organization and every connection it owns (`account-deletion.ts`).
 *
 * The current password is the proof, as for every credential change: a browser
 * left signed in is not enough to destroy the account. The "type DELETE" box
 * in the dialog is a typo guard and never travels — the same reasoning
 * `password.patch.ts` gives for the confirmation field.
 *
 * POST rather than DELETE with a body, which some proxies drop.
 *
 * Sessions cascade with the user row; the cookie is cleared here so the browser
 * stops presenting a dead one. The address is told afterwards, best effort, in
 * case it was not them.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword } = await parseBody(event, body)

  await requireCurrentPassword(user, currentPassword)
  const result = await deleteAccount(user)

  clearSessionCookie(event)
  notifyAccountDeleted(user.email, result.orgDeleted)

  return { ok: true, ...result }
})
