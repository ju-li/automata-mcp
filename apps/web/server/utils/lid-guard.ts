import type { AppInstance } from './app-db'
import { rememberBounded } from './lookup-cache'
import { sharedRecord } from './shared-cache'
import type { SharedRecord } from './shared-cache'

/**
 * Refuses a send whose recipient is a LID's digits passed as a phone number (#113).
 *
 * A LID (`79972425314508@lid`) is WhatsApp's per-person privacy alias. Its local
 * part looks like a phone number and is not one: no country code, no relation to
 * the person's number. A model that strips the suffix and passes the bare digits
 * to `send-text-message` has Evolution treat them as a phone number, and the
 * message either fails or reaches whoever owns that number. It cannot be unsent.
 * The tool description and server instructions steer away from it; this is the
 * check underneath them.
 *
 * **Fails closed only on a positive match.** Cold sends to new numbers are a
 * supported use, so digits this account has never seen as a LID go through, and
 * so does a send when the lookup cannot answer (logged, never silent) — the
 * alternative is that a message-database outage stops every send. A connection
 * with no message database is not checked at all: it has no read tools either,
 * so the model has no LID digits from us to misuse except through `list-chats`'
 * `findChats` walk, which shows them only as full JIDs.
 *
 * **What counts as "seen"**: any `…@lid` a message on this account names — chat,
 * group sender, alternate form, @-mention (`lidLocalParts` in evolution-db.ts).
 * Those are what the read tools surface, mentions especially: an unresolved one
 * stays as `@79972425314508` in the text, the likeliest digits to be lifted.
 *
 * **Cost (#319).** The set is one scan of the account's rows — 0.5 s warm, up to
 * 9 s cold, and past the 10 s statement timeout under checkpoint I/O — so it is
 * never built on a send's path:
 *
 * - **It only grows.** A LID never stops being one, so after the first full
 *   read a refresh extracts only from messages at or after `coveredTo` less
 *   `RECENT_MARGIN_S` (a message delivered after a reconnect carries its
 *   original, older timestamp) and adds them. `message_instance_ts_idx` makes
 *   that read cheap; without the index it costs a full scan again, with the same
 *   answer.
 * - **It is shared.** Kept in-process and in Redis (`sharedRecord`, when
 *   `NUXT_REDIS_URL` is set), so a deploy, a restart or another replica starts
 *   from the last set rather than from nothing. Digits only — no names, no
 *   content — the same identifiers the chat listing cache already holds.
 * - **It is read in the background.** One build at a time per process, on its
 *   own one-connection pool with the background count's minute-long timeout
 *   (`lidLocalParts`' `background`), never the slots the account's reads share,
 *   plus a deadline for a user-supplied database that ignores it. Queued by the
 *   send that finds the set missing, or older than `REFRESH_AFTER_S`. Only a
 *   connection with no set anywhere waits for it, at most `FIRST_BUILD_WAIT_MS`.
 *
 * Whatever the set covers, a send whose digits are not in it pays one more read
 * that extracts only from messages since `coveredTo` (less the margin), stopping
 * at the first match — so a LID first seen a minute ago, or one the set has not
 * caught up with, is still refused. With no set yet, that reach is the last
 * `RECENT_MARGIN_S` only: the guard at its weakest, as it was after a failed
 * build before. History import writes old timestamps all at once, but only at
 * pairing, so it lands inside the next refresh's window.
 *
 * **Not a normaliser.** `recipientDigits` approximates Evolution's `createJid()`
 * only to decide which digits a value *would* be sent to, and is used only to
 * refuse. Nothing is rewritten and nothing is addressed by what it returns, so
 * "never normalise JIDs locally" is not in play: a mismatch costs a missed
 * refusal (today's behaviour) or a refusal of digits this account knows as a LID.
 */

/** A set whose coverage is older than this is refreshed (in the background) by the next send. */
const REFRESH_AFTER_S = 10 * 60
/** After a failed build, how long before a send queues another one. */
const RETRY_MS = 2 * 60_000
const RECENT_MARGIN_S = 24 * 60 * 60
/**
 * A set covering up to this recently makes the recent check redundant: its read
 * saw every row the check would, bar what arrived while it ran.
 */
const JUST_BUILT_S = 30
/**
 * How long a send to a connection with no set at all waits for the first build.
 * A warm build takes well under a second, so the very first send after a cold
 * start usually gets the whole set; past this it goes on with the recent check.
 */
const FIRST_BUILD_WAIT_MS = 3_000
/** How long Redis keeps a set nobody refreshed. An old set is still right, only shorter. */
const SHARED_KEEP_MS = 30 * 24 * 60 * 60_000
/** Connections held at once; least recently stored dropped first. */
const MAX_ENTRIES = 500

interface Known {
  lids: Set<string>
  /**
   * Unix seconds when the read that completed this set started: every message
   * stamped before it (less the margin) has been looked at.
   */
  coveredTo: number
}

/** As stored in Redis. */
interface StoredKnown {
  lids: string[]
  coveredTo: number
}

const known = new Map<string, Known>()

let shared: SharedRecord<StoredKnown> | undefined
/** Created on first use, never at module load, so no other module has to be initialised first. */
function sharedLids(): SharedRecord<StoredKnown> {
  return shared ??= sharedRecord<StoredKnown>({ namespace: 'known-lids', ttlMs: SHARED_KEEP_MS })
}

/**
 * The digits Evolution would send to when `number` is not a JID it passes
 * through — or `undefined` when it is one, or holds no digits.
 *
 * 2.3.7's `createJid()` returns a value containing `@g.us`, `@s.whatsapp.net`,
 * `@lid` or `@broadcast` unchanged; anything else is cut at `:` and `@` and
 * stripped to digits, so `79972425314508@c.us` is a phone number to it too.
 */
export function recipientDigits(number: string): string | undefined {
  if (/@(?:lid|s\.whatsapp\.net|g\.us|broadcast)/i.test(number)) return undefined
  const digits = number.replace(/:\d+/, '').split(':')[0]!.split('@')[0]!.replace(/\D/g, '')
  return digits || undefined
}

export async function assertNotBareLid(instance: AppInstance, number: string): Promise<void> {
  const digits = recipientDigits(number)
  if (!digits || !canReadMessages(instance)) return

  const entry = await knownLids(instance)
  if (entry?.lids.has(digits)) refuse(number, digits)
  // A set read moments ago already looked at nearly every row the recent check
  // would; running it too is the same read twice.
  const now = Date.now() / 1000
  if (entry && now - entry.coveredTo < JUST_BUILT_S) return

  const since = Math.floor(entry?.coveredTo ?? now) - RECENT_MARGIN_S
  let recent: Set<string>
  try {
    recent = await lidLocalParts(instance, { since, localPart: digits })
  }
  catch (error) {
    console.error(`[lid-guard] could not check recent messages for connection ${instance.id}; sending unchecked:`, error)
    return
  }
  if (recent.has(digits)) {
    // Known now; save the next send to these digits the extra read. The next
    // refresh carries it to Redis.
    entry?.lids.add(digits)
    refuse(number, digits)
  }
}

function refuse(number: string, digits: string): never {
  throw createError({
    statusCode: 422,
    message: `Not sent: "${number}" is the digits of a WhatsApp LID on this account (${digits}@lid), `
      + 'a privacy alias and not a phone number. Sending to it as a number would reach whoever '
      + `owns that number, if anyone. To reply in that chat, pass its full jid "${digits}@lid" as number.`,
  })
}

/**
 * The set for this connection, from this process or Redis — never read from the
 * message database here. Queues a background build when there is none, or a
 * refresh when it is old; only the first waits, and only briefly.
 */
async function knownLids(instance: AppInstance): Promise<Known | undefined> {
  const entry = known.get(instance.id) ?? adopt(instance.id, await sharedLids().read(instance.id))
  if (entry) {
    if (!isFresh(entry)) void scheduleBuild(instance)
    return entry
  }
  // Never rejects: scheduleBuild doesn't, and a missed wait just means the set isn't ready yet.
  await withDeadline(scheduleBuild(instance), FIRST_BUILD_WAIT_MS, `known LIDs for connection ${instance.id}`).catch(() => {})
  return known.get(instance.id)
}

function isFresh(entry: Known): boolean {
  return Date.now() / 1000 - entry.coveredTo < REFRESH_AFTER_S
}

/**
 * Fold a set read from Redis into this process's, and answer the result. A
 * union is always right — each side is complete up to its own `coveredTo`, so
 * together they are complete up to the later one. Anything malformed is ignored.
 */
function adopt(instanceId: string, stored: StoredKnown | undefined): Known | undefined {
  const local = known.get(instanceId)
  if (!stored || !Array.isArray(stored.lids) || !Number.isFinite(stored.coveredTo)) return local

  const lids = new Set(local?.lids)
  for (const lid of stored.lids) if (typeof lid === 'string' && lid) lids.add(lid)
  const entry = { lids, coveredTo: Math.max(stored.coveredTo, local?.coveredTo ?? 0) }
  rememberBounded(known, instanceId, entry, MAX_ENTRIES)
  return entry
}

// ── background builds (#319) ───────────────────────────────────────────────
// One at a time per process, oldest request first, like `countInBackground` in
// instances.ts: a cold read of a large account is I/O-bound, and two side by
// side compete for the disk they are both waiting on. Not shared across
// replicas: two that queue the same account at the same moment each read it,
// which costs a read, not a wrong answer — and a replica that finds a fresher
// set in Redis when its turn comes skips the read.

interface Queued {
  instance: AppInstance
  done: Promise<void>
  settle: () => void
}

const queue = new Map<string, Queued>()
const failedAt = new Map<string, number>()
/** Set from the first build to the last with no await in between, so it doubles as "draining". */
let running: { id: string, done: Promise<void>, forgotten: boolean } | undefined

/** Queue a build for this connection; resolves when it has finished, either way. */
function scheduleBuild(instance: AppInstance): Promise<void> {
  const queued = queue.get(instance.id)
  if (queued) return queued.done
  if (running?.id === instance.id) return running.done
  const failed = failedAt.get(instance.id)
  if (failed !== undefined && Date.now() - failed < RETRY_MS) return Promise.resolve()

  let settle!: () => void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  queue.set(instance.id, { instance, done, settle })
  if (!running) drainBuilds().catch(error => console.error('[lid-guard] background builds stopped:', error))
  return done
}

async function drainBuilds(): Promise<void> {
  for (;;) {
    const next = queue.entries().next()
    if (next.done) break
    const [id, { instance, done, settle }] = next.value
    queue.delete(id)
    const current = { id, done, forgotten: false }
    running = current
    try {
      await build(instance, current)
      failedAt.delete(id)
    }
    catch (error) {
      if (!current.forgotten) rememberBounded(failedAt, id, Date.now(), MAX_ENTRIES)
      console.error(
        `[lid-guard] could not read known LIDs for connection ${id}; sends rely on the stored set, if any, `
        + `and the recent check, retrying in ${RETRY_MS / 60_000} minutes:`,
        error,
      )
    }
    finally {
      running = undefined
      settle()
    }
  }
}

/**
 * Bring the connection's set up to now: adopt a fresher one from Redis if
 * another replica read since, else read — everything the first time, only from
 * `coveredTo` less the margin after that — and store the union in both places.
 */
async function build(instance: AppInstance, current: { forgotten: boolean }): Promise<void> {
  const entry = adopt(instance.id, await sharedLids().read(instance.id))
  if (entry && isFresh(entry)) return

  const startedAt = Math.floor(Date.now() / 1000)
  const read = await withDeadline(
    lidLocalParts(instance, {
      since: entry ? entry.coveredTo - RECENT_MARGIN_S : undefined,
      background: true,
    }),
    BACKGROUND_COUNT_TIMEOUT_MS + 15_000,
    `known LIDs for connection ${instance.id}`,
  )
  if (current.forgotten) return

  // Everything known before, plus what sends added while this ran.
  const latest = known.get(instance.id)
  const lids = new Set(read)
  for (const lid of entry?.lids ?? []) lids.add(lid)
  if (latest !== entry) for (const lid of latest?.lids ?? []) lids.add(lid)
  const built = { lids, coveredTo: Math.max(startedAt, latest?.coveredTo ?? 0) }

  rememberBounded(known, instance.id, built, MAX_ENTRIES)
  sharedLids().write(instance.id, { lids: [...lids], coveredTo: built.coveredTo })
}

/** A deleted connection's set: here, in Redis, and in the queue. */
export function forgetKnownLids(instanceId: string): void {
  known.delete(instanceId)
  failedAt.delete(instanceId)
  const queued = queue.get(instanceId)
  if (queued) {
    queue.delete(instanceId)
    queued.settle()
  }
  if (running?.id === instanceId) running.forgotten = true
  sharedLids().forget(instanceId)
}
