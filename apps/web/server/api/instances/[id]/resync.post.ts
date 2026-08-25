/**
 * Disconnect and arm a full-history import for the next pairing.
 *
 * Destructive from the user's point of view — the account goes offline and only
 * comes back after a QR scan on the phone — so the UI confirms before calling it.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  await enableFullHistorySync(instance)
  return { ok: true }
})
