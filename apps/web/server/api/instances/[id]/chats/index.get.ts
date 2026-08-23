/**
 * Conversations for the scope picker.
 *
 * Evolution builds this from its message table, so a freshly paired account
 * returns an empty list. That is expected, not an error — the picker offers
 * adding a number by hand for exactly this case.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  return { chats: await listChats(instance) }
})
