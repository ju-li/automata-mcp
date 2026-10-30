/**
 * What the sync knows about a mailbox: its folders with counts, the last run,
 * and the limits the backfill works inside. A database read — no login to the
 * mail server — so the dashboard can poll it.
 *
 * Readable by anyone the connection is assigned to; a member already reaches
 * the same facts through `list-mail-folders` and `get-mailbox-status`.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireReadableInstanceOfKind(event, getRouterParam(event, 'id'), 'imap')

  const [sync, folders] = await Promise.all([mailSyncState(instance), listMailFolders(instance)])
  return {
    sync: sync && {
      lastAttemptAt: sync.lastAttemptAt,
      lastSuccessAt: sync.lastSuccessAt,
      lastErrorAt: sync.lastErrorAt,
      ...(sync.lastErrorCode && { lastError: imapErrorMessage(sync.lastErrorCode) }),
      authFailed: sync.authFailed,
    },
    folders: folders.map(({ uidvalidity: _, ...folder }) => folder),
    limits: mailSyncLimits(),
  }
})
