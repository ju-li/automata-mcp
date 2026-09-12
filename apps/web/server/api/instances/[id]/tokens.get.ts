/**
 * The connector tokens on one connection.
 *
 * A member sees only the tokens issued to them. A token's label names where a
 * colleague runs Claude, and its `last_used_at` and scope are not theirs to
 * read, so the narrowing is a predicate in the query rather than a filter over
 * rows that were already fetched.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  return {
    tokens: await listTokens(instance.id, {
      assignedTo: actor.role === 'admin' ? undefined : actor.user.id,
    }),
  }
})
