/**
 * One connection, with whatever "state" means for its kind.
 *
 * The kinds answer with different fields on purpose — a QR code and a profile
 * picture have no analogue for a database, and inventing one would make the
 * dashboard render an empty version of the wrong panel. `connectionState()`
 * owns that split; the page picks its panel from `instance.kind`.
 *
 * Not tolerant, unlike the listing: asked for one connection by id, a
 * half-provisioned row should say so rather than report a state it does not
 * have.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))

  return {
    instance: toPublicInstance(instance),
    ...await connectionState(instance),
  }
})
