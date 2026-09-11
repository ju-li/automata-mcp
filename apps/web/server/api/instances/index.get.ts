/**
 * The user's connections, each with its live state.
 *
 * One round-trip per connection — an Evolution `fetchInstances` for a WhatsApp
 * account, a one-row query for a database. Fine for the handful a person will
 * have; if that stops being true, cache the state rather than dropping it, since
 * the list is unreadable without it.
 *
 * `stats` is WhatsApp's own vocabulary and is simply absent for other kinds
 * rather than zeroed. A zeroed block would encode "this database has no
 * messages" into the payload, and the card does not read it anyway — it renders
 * `detail` instead. `connectionState()` is what keeps that per-kind shape in one
 * place rather than in every route that needs it.
 *
 * Tolerant, deliberately: a single half-provisioned connection must not take
 * the whole listing down with it, since the listing is the only way to reach
 * the page that would let you delete it.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const instances = await listInstancesForUser(user.id)

  const rows = await Promise.all(instances.map(async instance => ({
    ...toPublicInstance(instance),
    ...await connectionState(instance, { tolerant: true }),
  })))

  return { instances: rows }
})
