import { z } from 'zod'

const body = z.object({
  /** Empty string clears it, which turns reading off again rather than erroring. */
  dbUrl: z.string().max(2000),
})

/**
 * Set or clear the database URL for a connection on its own Evolution server.
 *
 * Reads go to Evolution's Postgres, and `NUXT_EVOLUTION_DATABASE_URL` names only
 * the database of the server this deployment configured. An account on a user's
 * own server needs its own URL, or `read-messages` and `search-messages` answer
 * 501 rather than answering zero rows for a conversation that is not empty.
 *
 * **Refused for a connection on the deployment's own server.** There is no use
 * case for overriding the operator's configuration per connection, and a stored
 * value that silently outranked it would be very hard to explain later. A 422
 * saying so beats accepting the write and ignoring it.
 *
 * Every connector token keeps working, deliberately: a token names the
 * connection, not the credential — the same rule `dsn.patch.ts` follows.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'whatsapp')
  const { dbUrl: raw } = await parseBody(event, body)
  const dbUrl = raw.trim()

  if (onDeploymentServer(instance)) {
    throw createError({
      statusCode: 422,
      message: 'This account is on the Evolution server this app is configured with, so it '
        + 'already reads through NUXT_EVOLUTION_DATABASE_URL. A per-connection database URL '
        + 'only applies to an account on your own Evolution server.',
    })
  }

  // Proved before it is stored — including that it is the right database, not
  // merely a reachable one. `requireTable` is what separates "wrong database"
  // from "account with no messages", which are otherwise identical answers.
  if (dbUrl) await probePgConnection(dbUrl, { requireTable: '"Message"' })

  const pb = await pocketbaseAdmin()
  const updated = await pb.collection('instances').update<AppInstance>(instance.id, {
    evolution_db_url: dbUrl,
  })

  // Drop the pool so the change takes effect now rather than at the next
  // fingerprint check. Belt and braces — `keyedPool` would notice on its own.
  await closeKeyedPool(`evo:${instance.id}`)

  return { instance: toPublicInstance(updated) }
})
