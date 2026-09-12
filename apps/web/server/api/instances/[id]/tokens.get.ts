/**
 * The connector tokens on one connection.
 *
 * A member sees only the tokens issued to them. A token's label names where a
 * colleague runs Claude, and its `last_used_at` and scope are not theirs to
 * read, so the narrowing is a predicate in the query rather than a filter over
 * rows that were already fetched.
 *
 * An admin additionally gets the holder's email on each row — they are looking
 * at the whole organization's tokens, so "whose is this" is the first question
 * the list has to answer. A member's own list carries no directory at all, so it
 * cannot leak an address.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireReadableInstance(event, getRouterParam(event, 'id'))

  if (actor.role !== 'admin') {
    return { tokens: await listTokens(instance.id, { assignedTo: actor.user.id }) }
  }

  const members = await listOrgMembers(actor.org.id)
  return {
    tokens: await listTokens(instance.id, {
      emails: new Map(members.map(member => [member.userId, member.email])),
    }),
  }
})
