/**
 * Take this connection away from a member.
 *
 * Their connector tokens on it are revoked in the same request, because the
 * alternative is a token that still reads "Active" in the UI and answers 401 on
 * the wire — and a handled 401 leaves nothing in the Nitro log for anyone to
 * diagnose. The count comes back so the UI can say what just happened, and the
 * listing carries the same count beforehand so the confirmation can name the
 * cost rather than asking "are you sure".
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const userId = getRouterParam(event, 'userId')

  if (!userId) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  // A member manages only through their own assignment (`managesInstance`), so
  // removing it would lock them out of the connection they are managing — and
  // revoke their tokens on it — in one click. An admin can still take a
  // member-created connection away from its creator; that is the admin's lever.
  if (actor.role !== 'admin' && userId === actor.user.id) {
    throw createError({
      statusCode: 409,
      statusMessage: 'You would lose access to this connection. Ask an admin to remove you, or delete the connection.',
    })
  }

  return { ok: true, ...await unassignInstance(actor.org.id, instance.id, userId) }
})
