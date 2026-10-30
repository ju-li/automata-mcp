/**
 * Two-minute mailbox sync: headers for every IMAP connection, a bounded amount
 * of work per mailbox per run. See server/utils/imap-sync.ts.
 *
 * Unlike the alert sweep this is safe on several replicas: each mailbox is
 * claimed by a lease in the database, so a second replica's run finds it taken
 * and moves on.
 */
export default defineTask({
  meta: {
    name: 'imap:sync',
    description: 'Sync headers for every IMAP mailbox connection',
  },
  async run() {
    const result = await runImapSync()
    if (result.claimed) console.info(`[imap-sync] synced ${result.claimed} mailbox(es), ${result.failed} failed`)
    return { result }
  },
})
