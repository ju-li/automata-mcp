/**
 * Say at boot where the shared caches live, and close Redis on shutdown.
 *
 * `NUXT_REDIS_URL` is optional (`server/utils/shared-cache.ts`): unset, every
 * cache is in-process — correct for one replica, and what self-hosted installs
 * get. One line here so an operator who meant to set it can see they did not,
 * and one from the client once it connects (or fails to).
 */
export default defineNitroPlugin((nitroApp) => {
  if (!sharedCacheConfigured()) {
    console.info('[redis] NUXT_REDIS_URL not set; caches are in-process, per replica.')
    return
  }

  startSharedCache()
  nitroApp.hooks.hook('close', () => stopSharedCache())
})
