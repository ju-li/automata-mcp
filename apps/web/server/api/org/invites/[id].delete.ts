import type { AppInvitation } from '~~/server/utils/pocketbase'

/**
 * Revoke a pending invitation; the link stops working immediately.
 *
 * Revoke rather than delete, matching how tokens are handled: the row survives
 * so "who invited whom, and what happened to it" stays answerable. An
 * invitation belonging to another organization answers 404, not 403 — an admin
 * has no business learning that some id exists elsewhere.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const id = getRouterParam(event, 'id')

  if (!id) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const pb = await pocketbaseAdmin()

  const invite = await getOneOrNone<AppInvitation>(pb, 'invitations', id)
  if (!invite || invite.org !== actor.org.id) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  await pb.collection('invitations').update(invite.id, { revoked: true })
  return { ok: true }
})
