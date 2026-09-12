import type { AppUser } from '~~/server/utils/pocketbase'

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

  const { movedFrom } = await acceptInviteInto(user, invite.org, invite.role)
  await markInviteAccepted(invite.id, user.id)

  return { ok: true, role: invite.role, movedFrom }
})
