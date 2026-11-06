/**
 * Ten-minute pass deleting WhatsApp connections nobody paired within an hour of
 * creating them. See server/utils/unpaired-reaper.ts.
 *
 * Safe on several replicas: each row is leased before it is probed, so a second
 * replica's run finds it taken and moves on.
 */
export default defineTask({
  meta: {
    name: 'instances:reap-unpaired',
    description: 'Delete WhatsApp connections left unpaired for more than an hour',
  },
  async run() {
    const result = await reapUnpairedConnections()
    if (result.reaped || result.failed) {
      console.info(`[reaper] ${result.reaped} unpaired connection(s) deleted, ${result.failed} failed`)
    }
    return { result }
  },
})
