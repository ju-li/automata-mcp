/** End the WhatsApp session. Keeps the instance, its token and its history. */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  await logoutInstance(instance)
  return { ok: true }
})
