export default defineKindTool({
  name: 'list-mail-folders',
  kind: 'imap',
  title: 'List mail folders',
  description:
    'List the folders of the connected mailbox that this token may read, INBOX first, with '
    + 'how many emails are synced and unread in each. Folder `path` is what list-emails and '
    + 'search-emails take as `folder`. `synced: false` folders (All Mail, Junk, Trash, and '
    + 'folders that cannot hold mail) exist on the server but are not synced, so nothing in '
    + 'them can be listed or searched. `serverMessages` is what the server reported the folder '
    + 'holds; when `history.complete` is false, older mail in that folder has not been synced '
    + '(`history.stopped` says if a limit stopped it).',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {},
  handler: async () => {
    const { instance, scope } = useMcpAuth()
    const [folders, sync] = await Promise.all([
      listMailFolders(instance, { allowed: scopedMailFolders(scope) }),
      mailSyncState(instance),
    ])
    const note = staleSyncNote(sync)
    return {
      count: folders.length,
      ...(sync?.lastSuccessAt && { syncedAt: sync.lastSuccessAt }),
      ...(note && { note }),
      folders: folders.map(({ uidvalidity: _, ...folder }) => folder),
    }
  },
})
