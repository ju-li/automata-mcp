/**
 * Destroy the account connection: the Evolution instance and everything it has
 * stored, plus every MCP token issued for it (they cascade with the row).
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  await deleteInstance(instance)
  recordHostedEventQuietly({ type: 'connection.deleted', org: actor.org.id, userId: actor.user.id, payload: { id: instance.id, kind: instance.kind } })
  return { ok: true }
})
