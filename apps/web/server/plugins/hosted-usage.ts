/**
 * Flush the in-memory MCP usage counts to `app.hosted_events` once a minute,
 * and once more on shutdown. Does nothing on a deployment without the hosted
 * offering: `countToolCall` never counts there, so every flush is empty.
 * See server/utils/hosted-events.ts.
 */
const FLUSH_MS = 60_000

export default defineNitroPlugin((nitroApp) => {
  if (!hostedEventsEnabled()) return

  const flush = () => flushUsage().catch((error) => {
    // The counts are gone with the failed batch; telemetry, not billing.
    console.error('[hosted-events] could not write the usage rollup:', error)
  })

  const timer = setInterval(flush, FLUSH_MS)
  timer.unref()

  nitroApp.hooks.hook('close', async () => {
    clearInterval(timer)
    await flush()
  })
})
