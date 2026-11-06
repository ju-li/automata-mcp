/**
 * Current pairing QR, or the connection state once pairing has completed.
 *
 * Polling this is what drives pairing: it asks Evolution to connect the first
 * time it is called on a disconnected instance, and after that only once
 * `close` has outlasted the connect hold — see `getInstanceQr`.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'whatsapp')
  return await getInstanceQr(instance)
})
