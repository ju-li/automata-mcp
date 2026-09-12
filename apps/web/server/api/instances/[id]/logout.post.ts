/** End the WhatsApp session. Keeps the instance, its token and its history. */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'whatsapp')
  await logoutInstance(instance)
  return { ok: true }
})
