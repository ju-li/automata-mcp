/**
 * One connection, with whatever "state" means for its kind.
 *
 * The two branches return different fields on purpose — a QR code and a profile
 * picture have no analogue for a database, and inventing one would make the
 * dashboard render an empty version of the wrong panel. The page picks its panel
 * from `instance.kind`.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))

  if (instanceKind(instance) === 'postgres') {
    const health = await getPostgresHealth(instance)
    return {
      instance: toPublicInstance(instance),
      state: health.state,
      detail: health.detail,
      error: health.error,
    }
  }

  const status = await getInstanceStatus(instance)
  return {
    instance: toPublicInstance(instance),
    ...status,
  }
})
