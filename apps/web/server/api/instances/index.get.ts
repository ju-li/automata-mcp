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
 * `detail` instead.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const instances = await listInstancesForUser(user.id)

  const rows = await Promise.all(instances.map(async (instance) => {
    const base = toPublicInstance(instance)

    if (instanceKind(instance) === 'postgres') {
      const health = await getPostgresHealth(instance)
      return {
        ...base,
        state: health.state,
        detail: health.detail,
        error: health.error,
      }
    }

    const status = await getInstanceStatus(instance).catch(() => null)
    return {
      ...base,
      state: status?.state ?? 'unknown',
      profileName: status?.profileName,
      profilePicUrl: status?.profilePicUrl,
      number: status?.number,
      stats: status?.stats ?? { messages: 0, chats: 0, contacts: 0 },
    }
  }))

  return { instances: rows }
})
