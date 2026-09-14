import type { AppInstance } from './pocketbase'
import type { Actor } from './org'

/**
 * Telegram connection lifecycle: the only callers of the bridge's admin key, so
 * its blast radius is this file — as `instances.ts` is for Evolution's.
 */

export interface TelegramProvisionInput {
  label?: string
  /**
   * A bridge the user runs. All or nothing: half of it is never completed from
   * this deployment's configuration — see `telegramAdminCredentials`.
   */
  server?: { baseUrl: string, adminKey: string, dbUrl?: string }
}

/**
 * Create a session on the bridge, then the row that points at it.
 *
 * Nothing is linked yet: pairing is a separate, explicit step on the dashboard,
 * because it binds a real Telegram account and a page refresh must never start
 * one. If the row cannot be written the session is deleted again, so a failed
 * create leaves nothing behind on the bridge.
 */
export async function provisionTelegramInstance(actor: Actor, input: TelegramProvisionInput = {}): Promise<AppInstance> {
  const { label, server } = input

  if (server) await assertPublicUrl(server.baseUrl, 'Telegram bridge URL')
  // Proved before anything is created. `requireTable` is what separates the
  // wrong database from an account with no chats, which otherwise look alike.
  if (server?.dbUrl) await probePgConnection(server.dbUrl, { requireTable: 'telegram.messages' })

  const creds = telegramAdminCredentials(server ? { base_url: server.baseUrl, admin_key: server.adminKey } : undefined)
  if (!creds) {
    throw createError({
      statusCode: 422,
      statusMessage: 'No Telegram bridge is available. Set NUXT_TELEGRAM_URL and NUXT_TELEGRAM_ADMIN_KEY '
        + 'to provide a default, or supply your own bridge URL and admin key.',
    })
  }

  const admin = createTelegramAdminBridge(creds)
  const name = generateInstanceName()

  let session: { id: string, apiKey: string }
  try {
    session = await admin.createSession(name)
  }
  catch (error) {
    const status = httpStatusOf(error)
    console.error(`[telegram] could not create a session on ${creds.userSupplied ? 'a user-supplied' : 'the deployment'} bridge: ${status ?? (error as Error | undefined)?.message}`)
    if (status === 401) {
      throw createError({ statusCode: 422, statusMessage: 'The Telegram bridge refused the admin key.' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Could not reach the Telegram bridge to create the connection.' })
  }

  try {
    const pb = await pocketbaseAdmin()
    return await pb.collection('instances').create<AppInstance>({
      org: actor.org.id,
      created_by: actor.user.id,
      kind: 'telegram',
      name,
      instance_id: session.id,
      api_key: session.apiKey,
      // The URL actually used, never runtimeConfig, for the reason
      // provisionWhatsappInstance gives.
      base_url: creds.baseUrl,
      admin_key: server ? server.adminKey : '',
      telegram_db_url: server?.dbUrl ?? '',
      label: label?.trim() || 'Telegram account',
    })
  }
  catch (error) {
    await admin.deleteSession(session.id).catch(() => {})
    throw error
  }
}

/**
 * Release what a Telegram connection holds: its reader pool, and its session on
 * the bridge — which logs the account out on Telegram's side and deletes every
 * chat synced for it.
 *
 * Throws when the bridge cannot be reached, so the row survives and still points
 * at a live session — the ordering `deleteInstance` insists on. A missing admin
 * key is not a reason to refuse, for the reason given there: a connection nobody
 * can delete is worse than a logged orphan.
 */
export async function deleteTelegramSession(instance: AppInstance): Promise<void> {
  await closeKeyedPool(`tg:${instance.id}`)

  const creds = telegramAdminCredentials(instance)
  if (!creds || !instance.instance_id) {
    console.error(
      `[telegram] deleting ${instance.id} (${instance.name}) without removing its bridge session: `
      + 'no admin key is available for its bridge. The session may need removing there by hand.',
    )
    return
  }

  try {
    await createTelegramAdminBridge(creds).deleteSession(instance.instance_id)
  }
  catch (error) {
    // Already gone on the bridge; carry on and remove the row.
    if (httpStatusOf(error) !== 404) throw error
  }
}
