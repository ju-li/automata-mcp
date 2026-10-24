import type { Db } from './app-db'

/**
 * The hosted offering's outbox: `app.hosted_events`.
 *
 * Account and organization changes, and per-minute MCP usage rollups, written
 * here for a separate service to turn into billing seats, CRM records (Brevo)
 * and product telemetry (PostHog). The web app writes rows and never reads
 * them; it does not know who consumes them or what they become.
 *
 * **Nothing is written on a self-hosted deployment.** `hostedEventsEnabled()`
 * is the one gate, and today it is "billing is on" — the only deployment that
 * sets it is the hosted one. When the separate cloud service exists it becomes
 * "the cloud service is configured". Until then rows accumulate on the hosted
 * database; that is the backlog the CRM sync starts from, not a leak.
 *
 * Rules a new event type must keep:
 *
 * - **Same transaction as the change** wherever the change has one: pass the
 *   transaction as `db`, so an event exists exactly when its change committed.
 *   The few changes made without a transaction (provisioning a connection)
 *   record after the fact through `recordHostedEventQuietly`.
 * - **Never in a payload:** credentials, connection strings, hosts, chat ids,
 *   folder or table names, message content, tool arguments. An email address is
 *   allowed, only on user events — the CRM keys contacts on it.
 * - **The type is a closed union** (`HostedEventType`), so a consumer can match
 *   exhaustively and a typo fails to compile.
 */

export type HostedEventType =
  | 'user.signed_up'
  | 'user.email_changed'
  | 'org.created'
  | 'org.deleted'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed'
  | 'connection.created'
  | 'connection.deleted'
  | 'token.created'
  | 'token.revoked'
  | 'plan.changed'
  | 'usage.rollup'

export interface HostedEvent {
  type: HostedEventType
  org?: string
  userId?: string
  payload?: Record<string, unknown>
}

export function hostedEventsEnabled(): boolean {
  return billingEnabled()
}

/**
 * Record one event inside the caller's transaction. Throws like any other
 * write in it, which rolls the change back with it — the event and the change
 * exist together or not at all.
 */
export async function recordHostedEvent(db: Db, event: HostedEvent): Promise<void> {
  if (!hostedEventsEnabled()) return
  await db`
    INSERT INTO app.hosted_events (type, org, user_id, payload)
    VALUES (${event.type}, ${event.org ?? null}, ${event.userId ?? null}, ${db.json((event.payload ?? {}) as never)})
  `
}

/**
 * Record an event for a change that has already happened outside a
 * transaction. Never throws: the change stands either way, and failing the
 * request over a lost event would be worse than losing it. Logged, since a
 * handled failure leaves nothing in Nitro's own log.
 */
export function recordHostedEventQuietly(event: HostedEvent): void {
  if (!hostedEventsEnabled()) return
  appDb()
    .then(sql => recordHostedEvent(sql, event))
    .catch((error) => {
      console.error(`[hosted-events] could not record ${event.type}:`, error)
    })
}

// ── MCP usage rollups ──────────────────────────────────────────────────────
//
// A row per MCP call would put a write on every connector request. Calls are
// counted in memory instead and flushed once a minute as one `usage.rollup`
// row per organization (server/plugins/hosted-usage.ts). A crash loses at
// most a minute of counts, which is fine for telemetry and the reason nothing
// billed may ever be derived from these rows.

interface UsageCounts {
  tools: Record<string, { ok: number, error: number }>
  tokens: Record<string, number>
}

let windowStart = new Date()
let pending = new Map<string, UsageCounts>()

/** Count one tool call. Synchronous and allocation-light: it runs on every call. */
export function countToolCall(orgId: string | undefined, tokenId: string, tool: string, ok: boolean): void {
  if (!orgId || !hostedEventsEnabled()) return
  let counts = pending.get(orgId)
  if (!counts) {
    counts = { tools: {}, tokens: {} }
    pending.set(orgId, counts)
  }
  const perTool = counts.tools[tool] ??= { ok: 0, error: 0 }
  if (ok) perTool.ok++
  else perTool.error++
  counts.tokens[tokenId] = (counts.tokens[tokenId] ?? 0) + 1
}

/**
 * Write the counts gathered since the last flush and start a new window. The
 * map is swapped out before the write, so calls counted while it runs land in
 * the next window rather than being lost or written twice.
 */
export async function flushUsage(): Promise<number> {
  if (!pending.size) {
    windowStart = new Date()
    return 0
  }
  const batch = pending
  const from = windowStart
  const to = new Date()
  pending = new Map()
  windowStart = to

  const sql = await appDb()
  await sql.begin(async (tx) => {
    for (const [org, counts] of batch) {
      await recordHostedEvent(tx, {
        type: 'usage.rollup',
        org,
        payload: { from: from.toISOString(), to: to.toISOString(), ...counts },
      })
    }
  })
  return batch.size
}
