import type { Billing } from './billing.ts'
import { BrevoError, type Crm, type SignupFacts, type Upserted, signupFactsOf } from './crm.ts'
import type { Sql } from './db.ts'
import { describeError } from './http-error.ts'

/**
 * Reads `app.hosted_events`, the outbox the web app writes in the same
 * transaction as each account change, and acts on it. Two consumers, each with
 * its own cursor in `cloud.cursors`. Rows are never deleted here, so a
 * consumer added later (telemetry) starts from the retained backlog without
 * the others having eaten it.
 *
 * **billing** — the web app no longer calls Stripe: this is how a join or a
 * removal reaches the seat count.
 *
 *   member.joined / member.removed   re-sync that organization's seats
 *   org.deleted                      cancel what it still pays for
 *
 * Seat syncs that fail are logged and passed over: seats are state, not
 * history, and the hourly reconcile re-syncs every billed organization. A
 * cancellation that fails stops the cursor at that event, so it is retried on
 * the next pass — nothing else would ever cancel it.
 *
 * **crm** — keeps a Brevo contact per user (crm.ts). Events only say whose
 * contact to refresh; what is sent is read live.
 *
 *   user.signed_up, user.email_changed,
 *   member.joined / .removed / .role_changed   that user
 *   plan.changed                               every member of that organization
 *
 * There is no reconcile behind it, so a contact that fails for a reason that
 * may pass (no answer, 5xx, rate limit, wrong key) stops the cursor just
 * before the first event naming that user; one Brevo refuses for good is
 * recorded in cloud.crm_skipped and passed over.
 */

const BILLING_CONSUMER = 'billing'
const CRM_CONSUMER = 'crm'
const BATCH = 500

interface EventRow {
  id: string
  type: string
  org?: string
}

/**
 * A consumer's position, created the first time it runs:
 *
 *   newest   billing. Seats are re-derived from membership by the reconcile,
 *            and no organization was deleted with a live subscription before
 *            that consumer existed (the web app refused it), so the history
 *            before then has nothing for billing to do.
 *   oldest   the CRM. Every signup in the retained backlog becomes a contact —
 *            the reason rows are retained. The row is only created once the
 *            sync is configured, so a deployment that adds the Brevo variables
 *            weeks later still starts from the beginning.
 */
async function readCursor(sql: Sql, consumer: string, startAt: 'newest' | 'oldest'): Promise<bigint> {
  const [row] = await sql<{ last_id: string }[]>`SELECT last_id FROM cloud.cursors WHERE consumer = ${consumer}`
  if (row) return BigInt(row.last_id)
  let start = 0n
  if (startAt === 'newest') {
    const [newest] = await sql<{ id: string | null }[]>`SELECT max(id)::text AS id FROM app.hosted_events`
    start = BigInt(newest?.id ?? '0')
  }
  await sql`
    INSERT INTO cloud.cursors (consumer, last_id) VALUES (${consumer}, ${start.toString()})
    ON CONFLICT (consumer) DO NOTHING
  `
  return start
}

async function advanceCursor(sql: Sql, consumer: string, last: bigint): Promise<void> {
  await sql`
    UPDATE cloud.cursors SET last_id = ${last.toString()}, updated = now() WHERE consumer = ${consumer}
  `
}

/**
 * One pass over whatever arrived since the last. Every event moves the cursor,
 * including the ones billing ignores (usage rollups, connection changes), so
 * the next pass never rescans them. Answers how many events it read.
 */
export async function consumeBillingEvents(sql: Sql, billing: Billing): Promise<number> {
  if (!billing.configured) return 0

  const from = await readCursor(sql, BILLING_CONSUMER, 'newest')
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

  if (last > from) await advanceCursor(sql, BILLING_CONSUMER, last)
  return events.length
}

interface CrmEventRow extends EventRow {
  user_id?: string
  payload: unknown
}

/**
 * One pass for the CRM. Answers how many events it read. Every event moves the
 * cursor unless a contact stops it, including the many the CRM ignores (usage
 * rollups, connection and token changes).
 */
export async function consumeCrmEvents(sql: Sql, crm: Crm): Promise<number> {
  if (!crm.configured || crm.paused || !await crm.prepare()) return 0

  const from = await readCursor(sql, CRM_CONSUMER, 'oldest')
  const events = await sql<CrmEventRow[]>`
    SELECT id::text AS id, type, org, user_id, payload FROM app.hosted_events
    WHERE id > ${from.toString()}
    ORDER BY id LIMIT ${BATCH}
  `
  if (events.length === 0) return 0

  // Whose contact the batch touches, and the first event naming each. Events
  // arrive in id order and only the first sighting is kept, so iterating the
  // map later goes in that order too — and a pass that stops on a user can put
  // the cursor just before them without skipping anyone earlier. The three
  // events of one signup collapse into one call.
  const firstEvent = new Map<string, bigint>()
  const facts = new Map<string, SignupFacts>()
  const touch = (userId: string | undefined, id: bigint) => {
    if (userId && !firstEvent.has(userId)) firstEvent.set(userId, id)
  }
  for (const event of events) {
    const id = BigInt(event.id)
    switch (event.type) {
      case 'user.signed_up':
        touch(event.user_id, id)
        if (event.user_id) facts.set(event.user_id, signupFactsOf(event.payload))
        break
      case 'user.email_changed':
      case 'member.joined':
      case 'member.removed':
      case 'member.role_changed':
        touch(event.user_id, id)
        break
      case 'plan.changed':
        if (event.org) for (const userId of await crm.membersOf(event.org)) touch(userId, id)
        break
    }
  }

  const users = await crm.loadUsers([...firstEvent.keys()])
  const counts: Record<Upserted | 'skipped', number> = { created: 0, claimed: 0, updated: 0, skipped: 0 }
  let stoppedAt: bigint | undefined
  for (const [userId, eventId] of firstEvent) {
    const user = users.get(userId)
    if (!user) {
      // The app deletes no accounts today, so this should not happen.
      console.warn(`[crm] user ${userId} (event ${eventId}) has no account any more; nothing to sync`)
      continue
    }
    try {
      counts[await crm.upsert(user, facts.get(userId))]++
    }
    catch (error) {
      if (!(error instanceof BrevoError)) throw error
      if (error.kind === 'permanent') {
        await crm.recordSkipped(eventId, userId, error)
        counts.skipped++
        console.warn(`[crm] Brevo refused the contact for user ${userId} (event ${eventId}): ${error.message}; recorded in cloud.crm_skipped`)
        continue
      }
      crm.pauseFor(error)
      stoppedAt = eventId
      break
    }
  }

  const last = stoppedAt === undefined ? BigInt(events.at(-1)!.id) : stoppedAt - 1n
  if (last > from) await advanceCursor(sql, CRM_CONSUMER, last)
  if (counts.created || counts.claimed || counts.updated || counts.skipped) {
    console.info(`[crm] contacts: ${counts.created} created, ${counts.claimed} claimed, ${counts.updated} updated, ${counts.skipped} skipped`)
  }
  return events.length
}
