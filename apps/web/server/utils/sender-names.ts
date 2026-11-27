import type { AppInstance } from './app-db'
import { rememberBounded } from './lookup-cache'
import { looksLikeIdentifier, meaningfulName } from './mentions'
import { readyRedis } from './redis'
import { sharedRecord } from './shared-cache'
import type { SharedRecord } from './shared-cache'

/**
 * Names for WhatsApp group senders, learned from their own live messages (#321).
 *
 * History-imported group rows name their sender only by LID digits (#263), and
 * most of those senders are neither saved contacts nor named in the group's
 * participant list (#279: 89% of 2,055 on one account). But anyone who has
 * posted since pairing left their own push name on a live row, beside the LID
 * (`lidLocalParts`' sibling, `lidSenderNames` in evolution-db.ts). This keeps
 * that LID → name map per connection, so a read names a sender from history
 * by what the same person called themselves later — on any chat of the account.
 *
 * **Account-wide on purpose, and only a label.** A name learned in one chat may
 * label a sender in another. Chat scope still decides which messages are read;
 * nothing here reaches a caller but the name itself — never the chat, group or
 * message it came from.
 *
 * **Lowest precedence, gaps only** (`addSenderNames` in mentions.ts): below
 * contacts, names WhatsApp gives in the participant list and names borrowed
 * through a participant's linked identity. A name from here never overwrites
 * one of those.
 *
 * **Never on the request path.** No index finds rows by `participant`, so the
 * first read of an account is a scan of its rows; a read only looks the map up,
 * and finding it missing or old queues a build — exactly `lid-guard.ts`' shape
 * (#319/#320), and kept apart from it on purpose: names must be dropped on
 * logout (a re-pair can be a different account) while the guard's LIDs need
 * not, so the two cover different ranges and cannot share one read.
 *
 * - **It grows.** After the first full read a refresh reads only from
 *   `coveredTo` less `RECENT_MARGIN_S` (a delivery after a reconnect keeps its
 *   original timestamp) and merges, newest row winning per LID — a renamed
 *   sender shows the new name after the next refresh. A row stamped before
 *   that margin when it arrives (a reconnect after more than a day away) is
 *   not read until the map is rebuilt from nothing, after a logout or once
 *   Redis and every process have let it go: the old name stays meanwhile.
 * - **It is shared.** In-process, and in Redis (`sharedRecord`, when
 *   `NUXT_REDIS_URL` is set) so a deploy or another replica starts from the
 *   last map. Display names are allowed there only because both copies are
 *   dropped on connection delete **and** on logout (`forgetSenderNames`); keys
 *   are connection ids; values are never logged. Another replica learns of the
 *   drop at its next refresh (≤ `REFRESH_AFTER_S` after its next read), when
 *   it finds the Redis copy gone and discards its own (`build`); a build already
 *   running elsewhere at the moment of the drop can write it back once. With no
 *   Redis, each replica forgets only on its own calls; with Redis down at the
 *   moment of the drop, its copy outlives it until `SHARED_KEEP_MS` — the
 *   reason that is a week, not a month. The Redis copy is cut to the newest
 *   senders past `SHARED_BUDGET_BYTES`, so it always lands.
 * - **It is read in the background.** One build at a time per process, on its
 *   own one-connection pool (`evo:…:names`), under the background timeout plus
 *   a deadline for a user-supplied database that ignores it. A read never
 *   waits: until the first build lands it names nobody new, which is the
 *   behaviour before this existed.
 *
 * Fails open: no message database, a failed build, Redis down — all mean "no
 * name from here", and the read goes on with what the other sources had.
 */

/** A map whose coverage is older than this is refreshed (in the background) by the next read. */
const REFRESH_AFTER_S = 10 * 60
/** After a failed build, how long before a read queues another one. */
const RETRY_MS = 2 * 60_000
const RECENT_MARGIN_S = 24 * 60 * 60
/**
 * How long Redis keeps a map nobody refreshed — also the bound on a copy whose
 * forget could not reach Redis (down at logout or delete).
 */
const SHARED_KEEP_MS = 7 * 24 * 60 * 60_000
/**
 * Budget for the Redis copy, under `shared-cache.ts`' 2 MiB value limit (which
 * drops an oversized write silently). Past it the newest senders are kept, so
 * the copy always lands and its absence still means "forgotten".
 */
const SHARED_BUDGET_BYTES = 1_500_000
/** Connections held at once; least recently stored dropped first. */
const MAX_ENTRIES = 500
/** WhatsApp caps push names far below this; a longer one is not a name we show. */
const MAX_NAME_LENGTH = 100

interface Named {
  name: string
  /** `messageTimestamp` of the row the name came from. */
  ts: number
  /** That row's `key.id`. */
  id: string
}

interface Entry {
  /** LID local part → newest usable name. */
  names: Map<string, Named>
  /** Unix seconds when the read that completed this map started. */
  coveredTo: number
}

/** As stored in Redis: tuples, since a large account holds thousands of senders. */
interface Stored {
  names: Array<[lid: string, name: string, ts: number, id: string]>
  coveredTo: number
}

/** Local part → name. What a read gets; never the rows behind it. */
export type SenderNameLookup = (localPart: string) => string | undefined

const entries = new Map<string, Entry>()
/**
 * Bumped by every forget. A Redis read in flight when a forget lands can still
 * answer with the old map; comparing generations around the await keeps it out.
 */
const generations = new Map<string, number>()
function generationOf(instanceId: string): number {
  return generations.get(instanceId) ?? 0
}

let shared: SharedRecord<Stored> | undefined
/** Created on first use, never at module load, so no other module has to be initialised first. */
function sharedNames(): SharedRecord<Stored> {
  return shared ??= sharedRecord<Stored>({ namespace: 'lid-names', ttlMs: SHARED_KEEP_MS })
}

/**
 * This connection's sender names, from this process or Redis — never read from
 * the message database here. Queues a background build when there is none, or a
 * refresh when it is old, and answers with what it has meanwhile.
 */
export async function senderNames(instance: AppInstance): Promise<SenderNameLookup | undefined> {
  if (!canReadMessages(instance)) return undefined

  let entry = entries.get(instance.id)
  if (!entry) {
    const generation = generationOf(instance.id)
    const stored = await sharedNames().read(instance.id)
    if (generationOf(instance.id) !== generation) return undefined
    entry = adopt(instance.id, stored)
  }
  if (!entry || !isFresh(entry)) void scheduleBuild(instance)
  if (!entry?.names.size) return undefined

  const { names } = entry
  return localPart => names.get(localPart)?.name
}

function isFresh(entry: Entry): boolean {
  return Date.now() / 1000 - entry.coveredTo < REFRESH_AFTER_S
}

/** The rule `lidSenderNames`' SQL approximates, applied for real. */
function usableName(raw: unknown, lid: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = meaningfulName(raw, lid)
  if (!name || name.length > MAX_NAME_LENGTH || looksLikeIdentifier(name)) return undefined
  return name
}

/** Same order as the SQL: newer row, then the greater id, then the greater name — byte for byte, like `COLLATE "C"`. */
function newer(a: Named, b: Named | undefined): boolean {
  if (!b) return true
  if (a.ts !== b.ts) return a.ts > b.ts
  const byId = Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
  if (byId !== 0) return byId > 0
  return Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) > 0
}

function merge(names: Map<string, Named>, lid: unknown, named: Named): void {
  if (typeof lid !== 'string' || !lid) return
  const name = usableName(named.name, lid)
  if (!name || !Number.isFinite(named.ts) || typeof named.id !== 'string') return
  const candidate = { name, ts: named.ts, id: named.id }
  if (newer(candidate, names.get(lid))) names.set(lid, candidate)
}

/**
 * Fold a map read from Redis into this process's, and answer the result. Each
 * side is complete up to its own `coveredTo`, so the merge (newest row per LID)
 * is complete up to the later one. Anything malformed is ignored.
 */
function adopt(instanceId: string, stored: Stored | undefined): Entry | undefined {
  const local = entries.get(instanceId)
  if (!stored || !Array.isArray(stored.names) || !Number.isFinite(stored.coveredTo)) return local

  const names = new Map(local?.names)
  for (const tuple of stored.names) {
    if (!Array.isArray(tuple)) continue
    const [lid, name, ts, id] = tuple
    merge(names, lid, { name, ts, id })
  }
  const entry = { names, coveredTo: Math.max(stored.coveredTo, local?.coveredTo ?? 0) }
  rememberBounded(entries, instanceId, entry, MAX_ENTRIES)
  return entry
}

// ── background builds ──────────────────────────────────────────────────────
// Same queue as `lid-guard.ts`' builds, for the same reasons: one at a time per
// process, oldest request first; not shared across replicas, and a replica that
// finds a fresher map in Redis when its turn comes skips the read.

interface Queued {
  instance: AppInstance
  done: Promise<void>
  settle: () => void
}

const queue = new Map<string, Queued>()
const failedAt = new Map<string, number>()
let running: { id: string, done: Promise<void>, forgotten: boolean } | undefined

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
  if (!running) drainBuilds().catch(error => console.error('[names] background builds stopped:', error))
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
        `[names] could not read sender names for connection ${id}; reads use the stored map, if any, `
        + `retrying in ${RETRY_MS / 60_000} minutes:`,
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
 * Bring the connection's map up to now: adopt a fresher one from Redis if
 * another replica read since, else read — everything the first time, only from
 * `coveredTo` less the margin after that — and store the merge in both places.
 */
async function build(instance: AppInstance, current: { forgotten: boolean }): Promise<void> {
  const stored = await sharedNames().read(instance.id)
  // A forget during the read: the answer may be the map it just dropped.
  if (current.forgotten) return
  // With Redis up, its copy is the shared one: missing there means another
  // replica forgot it (logout, delete) or it expired, so this replica's copy
  // goes too rather than being written back. Without Redis there is nothing to
  // compare with, and each replica forgets on its own calls only.
  if (!stored && readyRedis()) entries.delete(instance.id)
  const entry = adopt(instance.id, stored)
  if (entry && isFresh(entry)) return

  const startedAt = Math.floor(Date.now() / 1000)
  const rows = await withDeadline(
    lidSenderNames(instance, { since: entry ? entry.coveredTo - RECENT_MARGIN_S : undefined }),
    BACKGROUND_COUNT_TIMEOUT_MS + 15_000,
    `sender names for connection ${instance.id}`,
  )
  if (current.forgotten) return

  // Whatever this process holds now (an adopt may have landed meanwhile), plus the read.
  const latest = entries.get(instance.id) ?? entry
  const names = new Map(latest?.names)
  for (const row of rows) merge(names, row.lid, { name: row.name, ts: Number(row.ts), id: row.id })
  const built = { names, coveredTo: Math.max(startedAt, latest?.coveredTo ?? 0) }

  rememberBounded(entries, instance.id, built, MAX_ENTRIES)
  sharedNames().write(instance.id, { names: sharedTuples(names), coveredTo: built.coveredTo })
  // Counts only: a name is never logged.
  if (!entry) console.info(`[names] ${instance.id}: ${names.size} group senders named from their own messages`)
}

/**
 * The Redis copy: newest senders first, up to `SHARED_BUDGET_BYTES`. A replica
 * that adopts a cut copy names the older senders only after its own full read
 * — a connection it has never built — which is a missing label, not a wrong one.
 */
function sharedTuples(names: Map<string, Named>): Stored['names'] {
  const sorted = [...names].sort(([, a], [, b]) => b.ts - a.ts)
  const tuples: Stored['names'] = []
  let bytes = 0
  for (const [lid, named] of sorted) {
    // Tuple as JSON, near enough: quotes, commas, brackets and the digits of ts.
    bytes += Buffer.byteLength(lid) + Buffer.byteLength(named.name) + Buffer.byteLength(named.id) + 32
    if (bytes > SHARED_BUDGET_BYTES) break
    tuples.push([lid, named.name, named.ts, named.id])
  }
  return tuples
}

/**
 * A connection's names: here, in Redis, and in the queue. Called on delete and
 * on logout — a re-pair can be a different WhatsApp account, and the cache rule
 * allows display names only on those terms.
 */
export function forgetSenderNames(instanceId: string): void {
  rememberBounded(generations, instanceId, generationOf(instanceId) + 1, MAX_ENTRIES * 4)
  entries.delete(instanceId)
  failedAt.delete(instanceId)
  const queued = queue.get(instanceId)
  if (queued) {
    queue.delete(instanceId)
    queued.settle()
  }
  if (running?.id === instanceId) running.forgotten = true
  sharedNames().forget(instanceId)
}
