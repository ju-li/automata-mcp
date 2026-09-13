import type { AppInvitation } from '~~/server/utils/pocketbase'

/**
 * Email a pending invitation again, with a new link.
 *
 * The old code cannot be mailed: only its hash is stored. So this is a re-invite
 * of the same address with the same role — `createInvite` supersedes the pending
 * row, exactly as inviting the address again from the form does — followed by a
 * send. Address and role come from the stored row, never from the request, and
 * `invited_by` becomes whoever pressed the button.
 *
 * The throttle is checked **before** the new invitation is minted. Checked after,
 * a 429 would arrive having already killed the old link and delivered nothing.
 *
 * A failed send still answers 200, with `emailed: false` and the new link. By
 * then the old link is dead, so the only way the invitation survives is for the
 * admin to see the new one — the UI shows it once, as it does at creation.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const id = getRouterParam(event, 'id')

  if (!id) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const pb = await pocketbaseAdmin()

  const existing = await getOneOrNone<AppInvitation>(pb, 'invitations', id)
  if (!existing || existing.org !== actor.org.id) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  // Expired is fine — a resend is how an expired invitation gets renewed.
  if (existing.revoked || existing.accepted_at) {
    throw createError({
      statusCode: 409,
      statusMessage: existing.accepted_at
        ? 'This invitation has already been accepted.'
        : 'This invitation has been revoked or replaced. Refresh the page.',
    })
  }

  assertInviteMailAllowed(actor.org.id, existing.email)

  const { code, invite } = await createInvite(actor.org.id, actor.user, existing.email, existing.role)
  const emailed = await sendInviteEmail(event, actor, invite, code)

  return {
    invite,
    code,
    url: inviteUrl(event, code),
    emailed,
  }
})
