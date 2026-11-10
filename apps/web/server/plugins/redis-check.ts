/**
 * One line at boot saying where the MCP rate limit keeps its counts, so an
 * operator reading the log knows whether budgets hold across replicas. Never
 * fails boot: Redis is optional and its absence is a fallback, not an error.
 * See server/utils/redis.ts.
 */
export default defineNitroPlugin(() => {
  if (!redisConfigured()) {
    console.info('[redis] NUXT_REDIS_URL not set: MCP rate limits are kept in-process (per replica)')
    return
  }
  const client = redisClient()
  if (!client) return
  // Wait for the first connection rather than pinging at once: with the
  // offline queue off, a command sent before the socket is up fails by design.
  const timer = setTimeout(() => {
    console.warn('[redis] NUXT_REDIS_URL set but not reachable yet: MCP rate limits are kept in-process until it is')
  }, 5_000)
  client.once('ready', () => {
    clearTimeout(timer)
    console.info('[redis] connected: MCP rate limits are shared across replicas')
  })
})
