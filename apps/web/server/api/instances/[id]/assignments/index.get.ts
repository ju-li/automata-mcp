/**
 * Who can use this connection, and who else could be given it.
 *
 * Manager-only (an admin, or the member who created the connection), and it
 * returns the whole roster rather than just the assigned ones: the picker's job
 * is to show both halves at once, and every member can already read the roster
 * from `/api/org`.
 *
 * Admins also get the pending member invitations: ticking one gives the
 * connection to that person the moment they accept (see `markInviteAccepted`).
 *
 * Admins are listed as reaching the connection without holding an assignment
 * row, because they do — they reach every connection in the organization. A
 * picker that showed them as unassigned would invite someone to "grant" access
 * that is already there, and then show a checkbox that does nothing.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))

  // `tokens`: live tokens each person holds here, so the unassign confirmation
  // can name what it costs — they stop working the moment the assignment goes.
  // `invites`: pending member invitations, admins only — who has been invited
  // is an admin's view of the organization (`/api/org` carries it for them
  // alone), and a member who created this connection manages it, not the roster.
  const [members, assignees, tokens, invites] = await Promise.all([
    listOrgMembers(actor.org.id),
    listInstanceAssignees(instance.id),
    countTokensByHolder(instance.id),
    actor.role === 'admin' ? listInviteAssignments(actor.org.id, instance.id) : [],
  ])
  const assigned = new Set(assignees)

  const rows = members.map(member => ({
    userId: member.userId,
    email: member.email,
    role: member.role,
    assigned: assigned.has(member.userId),
    /** True for admins: reachable, but not through an assignment row. */
    implicit: member.role === 'admin',
    /** Created this connection: manages it for as long as they keep access. */
    creator: Boolean(instance.created_by) && instance.created_by === member.userId,
    tokens: tokens.get(member.userId) ?? 0,
  }))

  return { members: rows, invites }
})
