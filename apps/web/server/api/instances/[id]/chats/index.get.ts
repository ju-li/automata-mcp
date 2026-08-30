/**
 * Conversations for the scope picker and the dashboard's chat list.
 *
 * Evolution builds this from its message table, so a freshly paired account
 * returns an empty list. That is expected, not an error — the picker offers
 * adding a number by hand for exactly this case.
 *
 * `?take=` raises the page size for callers that mean to show everything, and
 * `?skip=` walks past it. Take is capped, and the default is left where
 * `listChats` has it, because the response carries a profile-picture URL per row
 * and the call also pulls Evolution's whole contact table to name the rows —
 * a cost paid per page, so one large page beats several small ones.
 *
 * The reply is a page, `{ chats, hasMore }`, and `hasMore` is the only
 * completeness signal a client should read. It is emphatically not the dashboard
 * chat count: that counts a different table (see `ChatPage` in `chats.ts`) and is
 * routinely larger than anything this can return.
 */
const MAX_TAKE = 2000

export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))

  const query = getQuery(event)

  const requestedTake = Number(query.take)
  const take = Number.isFinite(requestedTake)
    ? Math.min(Math.max(Math.trunc(requestedTake), 1), MAX_TAKE)
    : undefined

  const requestedSkip = Number(query.skip)
  const skip = Number.isFinite(requestedSkip)
    ? Math.max(Math.trunc(requestedSkip), 0)
    : undefined

  return await listChats(instance, { take, skip })
})
