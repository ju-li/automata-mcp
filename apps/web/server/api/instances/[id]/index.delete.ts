/**
 * Destroy the account connection: the Evolution instance and everything it has
 * stored, plus every MCP token issued for it (they cascade with the row).
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  await deleteInstance(instance)
  return { ok: true }
})
