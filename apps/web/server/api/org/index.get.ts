/**
 * The organization, its members, and — for an admin — its pending invitations.
 *
 * A member gets the roster: who else is here and who the admins are, which is
 * what makes "ask an admin to assign you a connection" an actionable sentence
 * rather than a dead end. Pending invitations are admin-only: an unaccepted
 * invitation names an email address that has not yet agreed to be associated
 * with this organization.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireMembership(event)

  return {
    org: { id: actor.org.id, name: actor.org.name },
    role: actor.role,
    members: await listOrgMembers(actor.org.id),
    invites: actor.role === 'admin' ? await listPendingInvites(actor.org.id) : undefined,
  }
})
