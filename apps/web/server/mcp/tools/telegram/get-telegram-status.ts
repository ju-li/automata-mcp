export default defineKindTool({
  name: 'get-telegram-status',
  kind: 'telegram',
  title: 'Check Telegram connection',
  description:
    'Report whether the connected Telegram account is online, which account it is '
    + 'signed in as, how many chats and messages have been synced, and whether older '
    + 'history is still being fetched. Call this before sending: only an account in the '
    + '`open` state can send. `sessionLost` means the account is still linked and its '
    + 'connection dropped; `revoked` means the session was ended from Telegram, and the '
    + 'account has to be linked again by scanning a QR code in the web app.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance } = useMcpAuth()
    return await getTelegramStatus(instance)
  },
})
