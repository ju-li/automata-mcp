/**
 * The connections this user can reach, each with its live state.
 *
 * An admin gets their whole organization's; a member gets only what has been
 * assigned to them. `listInstancesForActor` puts that in the query rather than
 * filtering afterwards — this route is an enumeration surface now, and a member
 * must not learn the size or the labels of the estate.
 *
 * `canManage` is decided here rather than in the client. The rule is one line,
 * but a second copy of it in the UI would drift, and the same argument
 * `canReadMessages` makes in `toPublicInstance` applies: the server owns the
 * answer, the client renders it.
 *
 * One round-trip per connection — two parallel Evolution reads for a WhatsApp
 * account (`fetchInstances` for the profile and counts, `connectionState` for
 * the live state; see `getInstanceStatus`), a one-row query for a database. Fine for the handful a person will
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
  const actor = await requireMembership(event)
  const instances = await listInstancesForActor(actor)

  const rows = await Promise.all(instances.map(async instance => ({
    ...toPublicInstance(instance),
    canManage: actor.role === 'admin',
    ...await connectionState(instance, { tolerant: true }),
  })))

  return { instances: rows }
})
