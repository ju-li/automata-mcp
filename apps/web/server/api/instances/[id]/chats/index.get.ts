/**
 * Conversations for the scope picker and the dashboard's chat list.
 *
 * Evolution builds this from its message table, so a freshly paired account
 * returns an empty list. That is expected, not an error — the picker offers
 * adding a number by hand for exactly this case.
 *
 * `?take=` raises the page size for callers that mean to show everything. It is
 * capped, and the default is left where `listChats` has it, because the response
 * carries a profile-picture URL per row and the call also pulls Evolution's whole
 * contact table to name the rows.
 */
const MAX_TAKE = 2000

export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))

  const requested = Number(getQuery(event).take)
  const take = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_TAKE)
    : undefined

  return { chats: await listChats(instance, take) }
})
