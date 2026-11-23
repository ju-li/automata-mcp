import type { AppInstance } from './app-db'
import { RECEIPT_RANK } from './evolution-db'
import type { SentMessageRef } from './evolution-db'
import { rememberBounded } from './lookup-cache'

/**
 * Whether WhatsApp acknowledged a message this app sent — the send half of the
 * dead-socket evidence (socket-evidence.ts, #239).
 *
 * **Why a 200 proves nothing.** `/message/sendText` answers 200 once Evolution
 * has handed the message to Baileys and stored its row as `PENDING`. WhatsApp's
 * server ack arrives later as a `messages.update`, which Evolution processes on
 * the account's serial event queue and writes into `"Message".status`
 * (`SERVER_ACK`, then `DELIVERY_ACK`, `READ`, `PLAYED`). On an account whose
 * receive side is wedged that queue never gets there: sends keep answering 200
 * and their rows stay `PENDING` for good. Production, Nov 15: an account stopped
 * receiving at 23:15 UTC, its send at 01:01 answered 200 and was still
 * `PENDING` hours later — and that 200 had *cleared* the evidence #205 relies on.
 *
 * So the send no longer clears anything. Instead, `ACK_CHECK_DELAY_MS` after a
 * send this reads the row's status once — `"Message".status`, and for a row
 * still `PENDING` its receipts in `"MessageUpdate"`, since Evolution often
 * records the ack there without moving the row (`readSentMessageStatus`; the
 * row alone raised false alarms on healthy accounts, Nov 19):
 *
 *   - **Past `PENDING`** — proof the socket worked: the miss run ends and
 *     evidence from before the send is cleared (`noteSocketAcknowledged`).
 *   - **Still `PENDING`, sent to a person** (`isDirectChat`) — a miss. **Two
 *     in a row** with no ack between record
 *     the socket dead (`noteSocketDead`, at the *later* send's time). Never one:
 *     a single stray `PENDING` happens on healthy accounts (1 of 2, 6 of 26 API
 *     sends in a day in production), while wedged ones had every send of the
 *     day pending.
 *   - **Still `PENDING`, sent to a group** (or any chat that is not a person)
 *     — unknown: neither a miss nor an ack, the run is left as it is. Group
 *     sends often never get a receipt recorded anywhere on healthy accounts:
 *     production, Nov 20, 12 h of API sends: 0 of 1109 to people without a
 *     receipt, 54 of 414 to groups (13 accounts), and one account flagged dead
 *     from three group sends while it was receiving normally. A group send
 *     that *is* acked still proves the socket.
 *   - **No row, any other status, or the read failed** — nothing; not knowing
 *     is not a miss.
 *
 * **Received traffic outranks a missing receipt.** A message stored as
 * received (`readLastInbound`, WhatsApp's own timestamp) came in over the
 * socket, and a dead socket or a wedged event queue stores none. So a miss is
 * read against it (`judgeMiss`): traffic since *this* send means the socket
 * worked after it — the receipt is only late, the run ends and older evidence
 * is cleared like an ack; traffic since the *previous* miss starts the run
 * again at one. Production, Nov 20: a healthy account's receipts for one
 * contact were written only when its next message arrived — 2.5 min and 13 min
 * late — and two such sends two hours apart, with six messages received
 * between them, recorded it dead. Read only on a miss, one index probe.
 *
 * Rules easy to undo:
 *
 *   - **The evidence is dated by the send, not the check.** `socketStalled`
 *     spends evidence older than Evolution's last reopen, and stock accounts
 *     reopen about every 50 minutes. A miss made after the last reopen must
 *     count, however early the run began — hence the later send's time, not the
 *     first miss's; and a send made before a reopen must not, hence not the
 *     check's time either.
 *   - **Only with a message database** (`canReadMessages`). Without one the
 *     send gives neither signal — same as `socketStalled`, which never reports
 *     a connection without one as stalled.
 *   - **In-process and best effort.** The run of misses and the pending checks
 *     live in this process; a restart or a send through another replica only
 *     delays detection. Timers are `unref`'d, capped in number, and never throw
 *     into anything — the send already answered.
 */

/** How long after a send its ack is looked for. WhatsApp's server ack normally takes well under a second. */
const ACK_CHECK_DELAY_MS = 2 * 60_000

/** Misses in a row, with no ack between, that record the socket dead. */
const MISSES_TO_RECORD = 2


/** Checks waiting on their timer, all connections together. Past it, new sends go unchecked. */
const MAX_PENDING_CHECKS = 2_000
let pendingChecks = 0

/**
 * Margin a received message's timestamp must clear to count as traffic after a
 * moment: it is the sender's clock, at one-second resolution, against ours.
 */
const TRAFFIC_CLOCK_SKEW_MS = 60_000

/** Per connection: misses in a row since the last ack or received traffic, and when the latest was sent. */
interface MissRun { count: number, lastSentAt: number }
const missRuns = new Map<string, MissRun>()
const MAX_MISS_RUNS = 10_000

/**
 * What `/message/sendText` answered, as the reference the check needs — or
 * `undefined` when the answer lacks it (nothing to look up, so no check).
 */
function sentMessageRef(result: Record<string, unknown>): SentMessageRef | undefined {
  const key = result.key as { id?: unknown, remoteJid?: unknown } | undefined
  const id = typeof key?.id === 'string' && key.id ? key.id : undefined
  const remoteJid = typeof key?.remoteJid === 'string' && key.remoteJid ? key.remoteJid : undefined
  const timestamp = Number(result.messageTimestamp)
  if (!id || !remoteJid || !Number.isFinite(timestamp) || timestamp <= 0) return undefined
  return { id, remoteJid, timestamp: Math.floor(timestamp) }
}

/**
 * Look for the ack of a message just sent, `ACK_CHECK_DELAY_MS` from now.
 * Fire and forget.
 */
export function watchSendAck(instance: AppInstance, result: Record<string, unknown>): void {
  if (!canReadMessages(instance)) return
  const sent = sentMessageRef(result)
  if (!sent) return
  if (pendingChecks >= MAX_PENDING_CHECKS) return

  const sentAt = new Date()
  pendingChecks += 1
  setTimeout(() => {
    pendingChecks -= 1
    checkSendAck(instance, sent, sentAt).catch((error) => {
      console.error(`[socket] connection ${instance.id}: could not check the ack of a send:`, error)
    })
  }, ACK_CHECK_DELAY_MS).unref?.()
}

async function checkSendAck(instance: AppInstance, sent: SentMessageRef, sentAt: Date): Promise<void> {
  let status: string | undefined
  try {
    status = await readSentMessageStatus(instance, sent)
  }
  catch (error) {
    // Unknown, not a miss. The message database's own faults are reported by
    // the reads that depend on it; one line here is enough.
    console.warn(`[socket] connection ${instance.id}: could not read the status of a sent message:`, (error as Error)?.message ?? error)
    return
  }

  const verdict = judgeAck(status, sent.remoteJid)
  if (verdict === 'acked') {
    missRuns.delete(instance.id)
    noteSocketAcknowledged(instance.id, sentAt)
    return
  }
  if (verdict !== 'missed') return

  const previous = missRuns.get(instance.id)
  const traffic = judgeMiss(await lastTrafficAt(instance), sentAt.getTime(), previous?.lastSentAt)
  if (traffic === 'since-send') {
    console.info(`[socket] connection ${instance.id}: a send is still PENDING ${ACK_CHECK_DELAY_MS / 1000} s on, `
      + 'but messages arrived since; not counted')
    missRuns.delete(instance.id)
    noteSocketAcknowledged(instance.id, sentAt)
    return
  }
  const misses = traffic === 'since-previous' ? 1 : (previous?.count ?? 0) + 1
  rememberBounded(missRuns, instance.id, { count: misses, lastSentAt: sentAt.getTime() }, MAX_MISS_RUNS)
  if (misses < MISSES_TO_RECORD) {
    console.info(`[socket] connection ${instance.id}: a send is still PENDING ${ACK_CHECK_DELAY_MS / 1000} s on (${misses} in a row)`)
    return
  }
  noteSocketDead(instance, 'unacked_sends', `send left unacknowledged (${misses} in a row)`, sentAt)
}

/**
 * When this account last stored a received message, ms — `undefined` when
 * unknown (no index, no grant, read failed). Unknown leaves the miss as it is.
 */
async function lastTrafficAt(instance: AppInstance): Promise<number | undefined> {
  try {
    const inbound = await readLastInbound(instance)
    const at = inbound?.at ? Date.parse(inbound.at) : Number.NaN
    return Number.isNaN(at) ? undefined : at
  }
  catch (error) {
    console.warn(`[socket] connection ${instance.id}: could not read the last received message:`, (error as Error)?.message ?? error)
    return undefined
  }
}

/**
 * What received traffic says about a miss. Pure.
 *
 *   - `since-send` — a message arrived after this send: the socket worked,
 *     the receipt is late. Not a miss.
 *   - `since-previous` — a message arrived after the previous miss's send:
 *     the run starts again at this miss.
 *   - `none` — nothing newer, or not known: the miss counts as it stands.
 */
function judgeMiss(
  trafficAt: number | undefined,
  sentAt: number,
  previousSentAt: number | undefined,
): 'since-send' | 'since-previous' | 'none' {
  if (trafficAt === undefined) return 'none'
  if (trafficAt > sentAt + TRAFFIC_CLOCK_SKEW_MS) return 'since-send'
  if (previousSentAt !== undefined && trafficAt > previousSentAt + TRAFFIC_CLOCK_SKEW_MS) return 'since-previous'
  return 'none'
}

/**
 * Whether a receipt is always recorded for a send to this chat: a person,
 * addressed by phone number or LID. A group send often never gets one
 * (`isDirectChat` false), so only its ack counts.
 */
function isDirectChat(remoteJid: string): boolean {
  return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')
}

/** What one stored status says about the socket. Pure. */
function judgeAck(status: string | undefined, remoteJid: string): 'acked' | 'missed' | 'unknown' {
  // Any receipt proves WhatsApp received the message. Read at call time, never
  // copied into a module-level const: utils share one bundle chunk, and a
  // top-level read of another file's export can run before it is initialised.
  if (status && (RECEIPT_RANK as readonly string[]).includes(status)) return 'acked'
  if (status === 'PENDING') return isDirectChat(remoteJid) ? 'missed' : 'unknown'
  return 'unknown'
}
