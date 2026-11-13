/**
 * Take a connection back from someone who has not accepted their invitation
 * yet. Admin-only, like the invitations list; nothing to revoke, since they
 * hold no tokens until they join.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  if (actor.role !== 'admin') throw createError({ statusCode: 404, statusMessage: 'Not found' })

  await unassignInvite(actor.org.id, instance.id, getRouterParam(event, 'inviteId'))
  return { ok: true }
})
