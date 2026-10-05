import type { AppUser } from '~~/server/utils/app-db'

/**
 * Accept an invitation as the signed-in account.
 *
 * Two credentials are required, not one. The code proves the invitation was
 * handed to you; the session proves who you are; and the two must agree — the
 * account's email has to match the address the invitation names. A 32-byte link
 * that leaks into a group chat is therefore not enough on its own to join an
 * organization, which is the property the email binding exists to give.
 *
 * The move itself is an UPDATE of the membership row — see `acceptInviteInto`
 * for why that, and not delete-then-create, is the only safe shape here.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event) as AppUser
  const code = getRouterParam(event, 'code')

  const { invite, problem } = await resolveInvite(code ? decodeURIComponent(code) : '')
  if (problem || !invite) {
    throw createError({
      statusCode: problem === 'not-found' || !problem ? 404 : 422,
      statusMessage: inviteProblemMessage(problem ?? 'not-found'),
    })
  }

  if (normaliseEmail(user.email) !== invite.email) {
    throw createError({
      statusCode: 403,
      statusMessage: `This invitation is for ${invite.email}. `
        + `You are signed in as ${user.email} — sign in as the invited address to accept it.`,
    })
  }

  // One transaction: the move and the invitation being spent happen together,
  // and a second acceptance of the same code finds it already spent.
  const sql = await appDb()
  const { movedFrom } = await sql.begin(async (tx) => {
    const moved = await acceptInviteInto(tx, user, invite.org, invite.role)
    await markInviteAccepted(tx, invite.id, user.id)
    return moved
  })

  return { ok: true, role: invite.role, movedFrom }
})
