/**
 * The connection itself, with no live state.
 *
 * Exists so the dashboard page can decide which panel to render without paying
 * for the round trip that panel is about to make anyway. This is a PocketBase
 * read and nothing else — no Evolution call, no database connection — so asking
 * for it first costs one cheap query rather than doubling the expensive one.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  return { instance: toPublicInstance(instance) }
})
