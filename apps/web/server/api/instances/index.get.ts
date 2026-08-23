/**
 * The user's connected WhatsApp accounts, each with its live connection state.
 *
 * One Evolution round-trip per instance. Fine for the handful a person will
 * have; if that stops being true, cache the state rather than dropping it —
 * the list is unreadable without it.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const instances = await listInstancesForUser(user.id)

  const rows = await Promise.all(instances.map(async (instance) => {
    const status = await getInstanceStatus(instance).catch(() => null)
    return {
      ...toPublicInstance(instance),
      state: status?.state ?? 'unknown',
      profileName: status?.profileName,
      profilePicUrl: status?.profilePicUrl,
      number: status?.number,
      stats: status?.stats ?? { messages: 0, chats: 0, contacts: 0 },
    }
  }))

  return { instances: rows }
})
