import { z } from 'zod'

const body = z.object({
  /** Empty string clears it, which turns reading off again rather than erroring. */
  dbUrl: z.string().max(2000),
})

/**
 * Set or clear the database URL for a connection on a bridge the user runs.
 *
 * The Telegram counterpart of `evolution-db.patch.ts`, and refused on the
 * deployment's own bridge for the same reason: that connection already reads
 * through NUXT_TELEGRAM_DATABASE_URL, and a stored value silently outranking the
 * operator's configuration would be very hard to explain later.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const { dbUrl: raw } = await parseBody(event, body)
  const dbUrl = raw.trim()

  if (onDeploymentBridge(instance)) {
    throw createError({
      statusCode: 422,
      message: 'This account is on the Telegram bridge this app is configured with, so it already reads '
        + 'through NUXT_TELEGRAM_DATABASE_URL. A per-connection database URL only applies to your own bridge.',
    })
  }

  // The right database, not merely a reachable one.
  if (dbUrl) await probePgConnection(dbUrl, { requireTable: 'telegram.messages' })

  const pb = await pocketbaseAdmin()
  const updated = await pb.collection('instances').update<AppInstance>(instance.id, {
    telegram_db_url: dbUrl,
  })
  await closeKeyedPool(`tg:${instance.id}`)

  return { instance: toPublicInstance(updated) }
})
