/**
 * Say at boot when Telegram connections cannot be read.
 *
 * Listing, reading and searching Telegram chats all read the bridge's database.
 * With a default bridge configured and no reader URL, those tools answer 500
 * while status and sending keep working — a confusing state to debug from a
 * client, so it is announced once where an operator reads the startup log.
 *
 * Silent when no default bridge is configured: that deployment either does not
 * use Telegram or only serves bring-your-own bridges, which carry their own URL.
 */
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  if (!config.telegramUrl || telegramDatabaseConfigured()) return

  console.error(
    '[startup] NUXT_TELEGRAM_URL is set but NUXT_TELEGRAM_DATABASE_URL is not. Listing, reading and '
    + 'searching chats will fail for Telegram connections on this deployment\'s bridge; status and '
    + 'sending still work. Point it at the bridge database as the telegram_reader role.',
  )
})
