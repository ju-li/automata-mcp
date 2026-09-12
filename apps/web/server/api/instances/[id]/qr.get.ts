/**
 * Current pairing QR, or the connection state once pairing has completed.
 *
 * Polling this is what drives pairing: Evolution starts the connection the
 * first time it is called on a disconnected instance.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'whatsapp')
  return await getInstanceQr(instance)
})
