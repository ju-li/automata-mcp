export default defineKindTool({
  name: 'get-mailbox-status',
  kind: 'imap',
  title: 'Check mailbox sync',
  description:
    'Report which mailbox this connector reads, whether its sync is working, when it last '
    + 'synced, and how much of each folder has been synced. Headers are synced every few '
    + 'minutes; `lastSyncedAt` says how fresh listings are, and mail that arrived after it is '
    + 'not listed yet. `error` explains a failing sync — a refused password can only be fixed '
    + 'by the account owner in the web app. `foldersStillSyncing` and `foldersStoppedAtLimit` '
    + 'say which folders hold older mail that has not been synced.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {},
  handler: async () => {
    const { instance, scope } = useMcpAuth()
    const allowed = scopedMailFolders(scope)
    const [health, sync, folders] = await Promise.all([
      getImapHealth(instance),
      mailSyncState(instance),
      listMailFolders(instance, { allowed }),
    ])
    const synced = folders.filter(folder => folder.synced)

    return {
      mailbox: `${instance.imap_user} @ ${instance.imap_host}`,
      state: health.state,
      ...(health.detail && { detail: health.detail }),
      ...(health.error && { error: health.error }),
      ...(sync?.lastSuccessAt && { lastSyncedAt: sync.lastSuccessAt }),
      folders: folders.length,
      syncedFolders: synced.length,
      syncedEmails: synced.reduce((sum, folder) => sum + folder.syncedMessages, 0),
      foldersStillSyncing: synced.filter(f => !f.history.complete && !f.history.stopped).map(f => f.path),
      foldersStoppedAtLimit: synced.filter(f => f.history.stopped).map(f => ({ path: f.path, stopped: f.history.stopped })),
      limits: mailSyncLimits(),
      ...(allowed && { note: 'This token is scoped to some folders; only those are counted.' }),
    }
  },
})
