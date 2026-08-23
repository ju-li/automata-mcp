export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  const status = await getInstanceStatus(instance)

  return {
    instance: toPublicInstance(instance),
    ...status,
  }
})
