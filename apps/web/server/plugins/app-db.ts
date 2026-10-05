/**
 * Prepare the app database at boot rather than on the first request, so a bad
 * NUXT_DATABASE_URL or a failed migration is in the
 * log the moment the server starts. `appDb()` logs its own failures and is
 * retried by the next request; nothing to do here but start it.
 */
export default defineNitroPlugin(() => {
  appDb().catch(() => {})
})
