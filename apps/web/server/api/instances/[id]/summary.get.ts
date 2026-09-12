/**
 * The connection itself, with no live state.
 *
 * Exists so the dashboard page can decide which panel to render without paying
 * for the round trip that panel is about to make anyway. This is a PocketBase
 * read and nothing else — no Evolution call, no database connection — so asking
 * for it first costs one cheap query rather than doubling the expensive one.
 *
 * It also carries `canManage`, which the panel uses to decide whether to render
 * the management controls at all. Decided here rather than in the client for the
 * reason `canReadMessages` gives: the server owns the rule, a second copy of it
 * in the UI would drift, and the page is already making this call.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  return {
    instance: toPublicInstance(instance),
    canManage: actor.role === 'admin',
  }
})
