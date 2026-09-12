/**
 * Who can use this connection, and who else could be given it.
 *
 * Admin-only, and it returns the whole roster rather than just the assigned
 * ones: the picker's job is to show both halves at once, and an admin can
 * already read the roster from `/api/org`.
 *
 * Admins are listed as reaching the connection without holding an assignment
 * row, because they do — they reach every connection in the organization. A
 * picker that showed them as unassigned would invite someone to "grant" access
 * that is already there, and then show a checkbox that does nothing.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))

  const members = await listOrgMembers(actor.org.id)
  const assigned = new Set(await listInstanceAssignees(instance.id))

  // How many live tokens each person holds on this connection, so the
  // unassign confirmation can name what it costs rather than asking "are you
  // sure" — those tokens stop working the moment the assignment goes.
  const rows = await Promise.all(members.map(async member => ({
    userId: member.userId,
    email: member.email,
    role: member.role,
    assigned: assigned.has(member.userId),
    /** True for admins: reachable, but not through an assignment row. */
    implicit: member.role === 'admin',
    tokens: await countTokensOn(member.userId, instance.id),
  })))

  return { members: rows }
})
