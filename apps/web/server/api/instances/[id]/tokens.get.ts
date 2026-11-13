/**
 * The connector tokens on one connection.
 *
 * Whoever manages the connection (an admin, or the member who created it) sees
 * all of them; any other member sees only the tokens issued to them. A token's label names where a
 * colleague runs Claude, and its `last_used_at`, clients and scope are not
 * theirs to read, so the narrowing is a predicate in the query rather than a
 * filter over rows that were already fetched.
 *
 * A manager additionally gets the holder's email on each row — they are looking
 * at everyone's tokens on the connection, so "whose is this" is the first
 * question the list has to answer. A member's own list carries no directory at all, so it
 * cannot leak an address.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireReadableInstance(event, getRouterParam(event, 'id'))

  if (!managesInstance({ role: actor.role, userId: actor.user.id }, instance, true)) {
    return { tokens: await listTokens(instance.id, { assignedTo: actor.user.id }) }
  }

  const members = await listOrgMembers(actor.org.id)
  return {
    tokens: await listTokens(instance.id, {
      emails: new Map(members.map(member => [member.userId, member.email])),
    }),
  }
})
