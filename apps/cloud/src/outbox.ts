import type { Billing } from './billing.ts'
import type { Sql } from './db.ts'
import { describeError } from './http-error.ts'

/**
 * Reads `app.hosted_events`, the outbox the web app writes in the same
 * transaction as each account change, and acts on the events billing cares
 * about. The web app no longer calls Stripe: this is how a join or a removal
 * reaches the seat count.
 *
 * Each consumer keeps its own cursor in `cloud.cursors`. Rows are never
 * deleted here, so a consumer added later (the CRM sync, telemetry) starts
 * from the retained backlog without this one having eaten it.
 *
 *   member.joined / member.removed   re-sync that organization's seats
 *   org.deleted                      cancel what it still pays for
 *
 * Seat syncs that fail are logged and passed over: seats are state, not
 * history, and the hourly reconcile re-syncs every billed organization. A
 * cancellation that fails stops the cursor at that event, so it is retried on
 * the next pass — nothing else would ever cancel it.
 */

const CONSUMER = 'billing'
const BATCH = 500

interface EventRow {
  id: string
  type: string
  org?: string
}

/**
 * Where this consumer starts the first time it runs: the newest event. Seats
 * are re-derived from membership by the reconcile, and no organization was
 * deleted with a live subscription before this consumer existed (the web app
 * refused it), so the history before now has nothing for billing to do.
 */
async function cursor(sql: Sql): Promise<bigint> {
  const [row] = await sql<{ last_id: string }[]>`SELECT last_id FROM cloud.cursors WHERE consumer = ${CONSUMER}`
  if (row) return BigInt(row.last_id)
  const [newest] = await sql<{ id: string | null }[]>`SELECT max(id)::text AS id FROM app.hosted_events`
  const start = BigInt(newest?.id ?? '0')
  await sql`
    INSERT INTO cloud.cursors (consumer, last_id) VALUES (${CONSUMER}, ${start.toString()})
    ON CONFLICT (consumer) DO NOTHING
  `
  return start
}

/**
 * One pass over whatever arrived since the last. Every event moves the cursor,
 * including the ones billing ignores (usage rollups, connection changes), so
 * the next pass never rescans them. Answers how many events it read.
 */
export async function consumeBillingEvents(sql: Sql, billing: Billing): Promise<number> {
  if (!billing.configured) return 0

  const from = await cursor(sql)
  const events = await sql<EventRow[]>`
    SELECT id::text AS id, type, org FROM app.hosted_events
    WHERE id > ${from.toString()}
    ORDER BY id LIMIT ${BATCH}
  `
  if (events.length === 0) return 0

  let last = from
  const seatOrgs = new Set<string>()
  for (const event of events) {
    if (event.type === 'org.deleted' && event.org) {
      try {
        await billing.cancelForDeletedOrg(event.org)
      }
      catch (error) {
        console.error(`[outbox] cancelling for deleted organization ${event.org} failed; retrying next pass: ${describeError(error)}`)
        break
      }
    }
    else if ((event.type === 'member.joined' || event.type === 'member.removed') && event.org) {
      seatOrgs.add(event.org)
    }
    last = BigInt(event.id)
  }

  for (const orgId of seatOrgs) {
    try {
      await billing.syncSeats(orgId)
    }
    catch (error) {
      console.error(`[outbox] seat sync for organization ${orgId} failed; the reconcile will retry: ${describeError(error)}`)
    }
  }

  if (last > from) {
    await sql`
      UPDATE cloud.cursors SET last_id = ${last.toString()}, updated = now() WHERE consumer = ${CONSUMER}
    `
  }
  return events.length
}
