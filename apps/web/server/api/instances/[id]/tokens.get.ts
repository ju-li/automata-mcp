export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  return { tokens: await listTokens(instance.id) }
})
