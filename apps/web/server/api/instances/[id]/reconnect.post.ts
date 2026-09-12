/**
 * Bring a dropped WhatsApp session back from its stored credentials.
 *
 * Answers once Evolution has been asked, not once the socket is up — that takes
 * a few seconds more, so the dashboard watches the status afterwards. If the
 * credentials were rejected the account comes back needing a QR scan instead,
 * which the dashboard sees as an ordinary pairing state.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'whatsapp')
  return { state: await reconnectInstance(instance) }
})
