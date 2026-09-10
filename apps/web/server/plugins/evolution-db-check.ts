/**
 * Say at boot when the MCP surface cannot work.
 *
 * `read-messages` and `search-messages` both read Evolution's database directly —
 * its API cannot deduplicate the rows a re-pair leaves behind, and cannot search
 * message content at all. Without `NUXT_EVOLUTION_DATABASE_URL` both answer 500,
 * while the web UI, pairing and `send-text-message` carry on working. That is a
 * confusing state to debug from a client, so it is announced once, here, where an
 * operator reading the startup log will see it.
 *
 * Scoped to accounts on *this deployment's* Evolution server. One that brought
 * its own server carries its own database URL and reads fine with this unset, so
 * the message must not claim reading is broken outright.
 */
export default defineNitroPlugin(() => {
  if (messageDatabaseConfigured()) return

  console.error(
    '[startup] NUXT_EVOLUTION_DATABASE_URL is not set. Reading and searching messages '
    + 'will fail for accounts on this deployment\'s Evolution server; pairing and sending '
    + 'still work, and an account on its own Evolution server reads through the database URL '
    + 'stored on that connection. See README "Reading and searching messages".',
  )
})
