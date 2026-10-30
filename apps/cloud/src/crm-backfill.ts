import { loadConfig } from './config.ts'
import { BrevoError, Crm, type CrmUser, type Upserted } from './crm.ts'
import { connect, ensureCloudSchema } from './db.ts'
import { describeError } from './http-error.ts'

/**
 * One-off: a Brevo contact for every account, including those created before
 * the outbox existed, which no `user.signed_up` event will ever name.
 *
 *   pnpm cloud:crm-backfill                 locally, with the root .env
 *   node src/crm-backfill.ts                inside the cloud service's container
 *
 * It walks `app.users` in id order through the same `upsert` the outbox
 * consumer uses, so it is safe to rerun and safe beside the running service:
 * a user who already has a contact is updated, which never touches lists. A
 * new contact goes on the product list, and on the marketing list only when
 * `marketing_consent_at` is set — which no account from before the checkbox
 * has, since nobody asked them. No signup facts are sent: none were recorded
 * for these accounts, and the consumer's own come from events.
 *
 * Failures follow the consumer's table: a refusal for good is recorded in
 * cloud.crm_skipped with no event id; a wrong key stops the run; anything
 * that may pass is retried a few times, then stops the run — rerun it.
 */

const PAGE = 100
const ATTEMPTS = 5

let config
try {
  config = loadConfig()
}
catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
if (!config.brevo) {
  console.error('crm-backfill: set BREVO_API_KEY, BREVO_PRODUCT_LIST and BREVO_MARKETING_LIST first.')
  process.exit(1)
}

const sql = connect(config.databaseUrl)
const crm = new Crm(sql, config.brevo)
let exitCode = 0

try {
  await ensureCloudSchema(sql)
  if (!await crm.prepare()) throw new Error('the Brevo sync is not ready; the reason is logged above')

  const counts: Record<Upserted | 'skipped', number> = { created: 0, claimed: 0, updated: 0, skipped: 0 }
  let after = ''
  for (;;) {
    const page = await sql<{ id: string }[]>`
      SELECT id FROM app.users WHERE id > ${after} ORDER BY id LIMIT ${PAGE}
    `
    if (page.length === 0) break
    after = page.at(-1)!.id

    const users = await crm.loadUsers(page.map(row => row.id))
    for (const user of users.values()) {
      counts[await syncOne(user)]++
    }
    console.info(`[crm-backfill] through ${after}: ${counts.created} created, ${counts.claimed} claimed, ${counts.updated} updated, ${counts.skipped} skipped`)
  }
  console.info('[crm-backfill] done')
}
catch (error) {
  console.error(`[crm-backfill] stopped: ${describeError(error)}. Rerun it; contacts already written are updated, not duplicated.`)
  exitCode = 1
}
finally {
  await sql.end({ timeout: 5 })
}
process.exit(exitCode)

/**
 * One contact, retried while Brevo's answer may pass, waiting out its rate
 * limit. A refusal for good is recorded and answers `skipped`; a wrong key, or
 * a failure that outlasts the attempts, throws and ends the run.
 */
async function syncOne(user: CrmUser): Promise<Upserted | 'skipped'> {
  for (let tries = 1; ; tries++) {
    try {
      return await crm.upsert(user)
    }
    catch (error) {
      if (!(error instanceof BrevoError)) throw error
      if (error.kind === 'permanent') {
        await crm.recordSkipped(undefined, user.id, error)
        console.warn(`[crm-backfill] Brevo refused the contact for user ${user.id}: ${error.message}; recorded in cloud.crm_skipped`)
        return 'skipped'
      }
      if (error.kind === 'auth' || tries >= ATTEMPTS) throw error
      const wait = Math.max((error.retryAt ?? 0) - Date.now(), 2 ** tries * 1000)
      console.warn(`[crm-backfill] ${error.message}; retrying in ${Math.ceil(wait / 1000)} s`)
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}
