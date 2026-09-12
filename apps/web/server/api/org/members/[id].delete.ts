/**
 * Remove a member from the organization.
 *
 * Their connector tokens are revoked and their connection assignments dropped,
 * in that order, before the membership goes. `resolveMcpAuth` would refuse the
 * tokens anyway once the membership is gone — this is what keeps the UI from
 * ever showing one as Active that is not.
 *
 * The account itself is untouched: removal is not deletion. They keep their
 * login and land on `/no-organization`.
 *
 * An admin may remove themselves, but not the last admin — `removeMember`
 * enforces that by deleting, re-counting, and restoring.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const member = await requireOrgMember(actor.org.id, getRouterParam(event, 'id'))

  const { revokedTokens } = await removeMember(actor.org.id, member)
  return { ok: true, revokedTokens }
})
