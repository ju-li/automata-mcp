import { createHash } from 'node:crypto'

/**
 * A cache of long-lived, credential-backed handles — one per connection row.
 *
 * **Why this is engine-independent and `pg-pool.ts` is not.** Everything here
 * is about *when* a handle is built, reused, re-checked and thrown away, and
 * none of that has anything to do with the protocol it speaks. A second copy
 * for a second driver would be a second copy of five decisions that each took a
 * bug to arrive at:
 *
 *   - **Keyed on the connection id, never on the credential.** A Map keyed on a
 *     DSN holds every user's database password as a live string in a structure
 *     that shows up in a heap snapshot and in a debugger. The id is enough to
 *     find the handle; a hash is enough to notice the credential changed.
 *   - **The approved address is deliberately NOT part of the identity.** A host
 *     with several A records (Neon, Supabase, any round-robin) returns them in
 *     a different order per query — `verbatim: true` preserves that — so keying
 *     on `resolved[0]` tore down and rebuilt the handle, TLS handshake and all,
 *     on essentially every call to exactly the hosts people point at.
 *   - **Re-approval is on a timer, not per call.** The handle keeps established
 *     sockets dialled at the address approved when it was built, so a fresh
 *     lookup moves no traffic. What it buys is noticing that a hostname has
 *     since been re-pointed somewhere it may not go, and a minute is soon
 *     enough for that.
 *   - **A rotated credential drains in the background.** Ending the old handle
 *     synchronously would kill queries still in flight on this request and on
 *     any concurrent one. A handle that is leased (below) is not ended at all
 *     until its last lease is released.
 *   - **A leased handle is never swept.** `lastUsed` is set on acquire, so a
 *     handle running one two-minute query looks idle for those two minutes,
 *     and the sweep used to end it under the query (`end({ timeout: 5 })`).
 *     `withKeyedResource` counts the work running on a handle; the idle sweep,
 *     the LRU cap and rotation all skip a handle with work running. The cost is
 *     that `MAX_POOLS` can be exceeded by the number of handles busy at once,
 *     which is bounded by concurrent requests, rather than ended mid-query.
 *   - **Eviction runs on acquire, not on a timer.** An interval outlives
 *     nothing useful in a worker the platform stops and starts, and sweeping on
 *     the path that already runs is deterministic and needs no lifecycle hook.
 *
 * What is *not* here, and must not migrate here: parsing a DSN, guarding a
 * host, pinning an address, and every driver option. Those differ per engine
 * and belong with the engine — see `pg-pool.ts`, which supplies them through
 * `build` and `reguard`.
 *
 * **`MAX_POOLS` is a process-wide budget, not a per-engine one.** That is the
 * one behaviour this extraction changes: a deployment holding many connections
 * of two different engines now shares one ceiling between them rather than
 * getting one each. That is the right reading of a resource limit, but it is a
 * change, so it is written down rather than discovered.
 */

const MAX_POOLS = 32
const POOL_IDLE_MS = 10 * 60_000
/** How long a host stays approved before the guard is re-run on it. */
const GUARD_TTL_MS = 60_000

interface Entry {
  value: unknown
  /** Closes `value`. Held per entry because it is per-driver. */
  destroy: (value: unknown) => Promise<void>
  /** Hash of the credential this handle was opened with. Rotating it rebuilds. */
  secretHash: string
  /** When the host guard last approved this handle's target. */
  guardedAt: number
  lastUsed: number
  /** Leases held through `withKeyedResource`. Never swept, ended or drained while > 0. */
  active: number
  /** Out of the map (credential rotated); ended when the last lease is released. */
  retired: boolean
}

const entries = new Map<string, Entry>()

export interface KeyedResourceSpec<T> {
  /** Open the handle. Called only when there is not already a live one. */
  build: () => Promise<T>
  /** Close it. `postgres` wants `end({ timeout })`; another driver will differ. */
  destroy: (value: T) => Promise<void>
  /**
   * Re-run the host guard, throwing if the target is no longer allowed.
   *
   * Omit for a handle whose address came from this deployment's own
   * configuration rather than from a user. That asymmetry is the whole of the
   * `guard` flag `pg-pool.ts` documents, and getting it backwards either breaks
   * the default deployment or opens the hole the guard exists to close.
   */
  reguard?: () => Promise<void>
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * The handle for one `key`, building it if needed.
 *
 * `key` namespaces the caller (`pg:<id>`, `evo:<id>`, `evo:default`) so two
 * purposes cannot collide on one instance id, and so a caller can evict its own
 * handle without knowing about anyone else's.
 */
export async function keyedResource<T>(
  key: string,
  secret: string,
  spec: KeyedResourceSpec<T>,
): Promise<T> {
  return (await acquire(key, secret, spec, false)).value as T
}

/**
 * Run `fn` with the handle for `key`, holding a lease on it for as long as `fn`
 * runs.
 *
 * Use this rather than `keyedResource` for anything that can run long — a
 * user's SQL query under a two-minute statement timeout. While the lease is
 * held, neither the idle sweep, the LRU cap nor a credential rotation ends the
 * handle; a rotated one is ended when its last lease is released. Releasing
 * also counts as use, so a handle that just finished a long query is not the
 * first one the LRU cap picks.
 */
export async function withKeyedResource<T, R>(
  key: string,
  secret: string,
  spec: KeyedResourceSpec<T>,
  fn: (value: T) => Promise<R>,
): Promise<R> {
  // The lease is taken inside `acquire`, with no await between finding the
  // entry and counting it, so a concurrent acquire's sweep cannot end it first.
  const entry = await acquire(key, secret, spec, true)
  try {
    return await fn(entry.value as T)
  }
  finally {
    entry.active -= 1
    entry.lastUsed = Date.now()
    if (entry.retired && entry.active === 0) {
      void entry.destroy(entry.value).catch(() => {})
    }
  }
}

async function acquire<T>(
  key: string,
  secret: string,
  spec: KeyedResourceSpec<T>,
  lease: boolean,
): Promise<Entry> {
  sweep()

  const secretHash = hashSecret(secret)
  const existing = entries.get(key)

  if (existing && existing.secretHash === secretHash) {
    if (spec.reguard && Date.now() - existing.guardedAt > GUARD_TTL_MS) {
      // Throws here if the hostname now resolves somewhere it may not go.
      await spec.reguard()
      existing.guardedAt = Date.now()
    }
    // The await above may have let a rotation retire this entry; take the
    // current one rather than lease a handle that is about to be ended.
    if (entries.get(key) === existing) {
      existing.lastUsed = Date.now()
      if (lease) existing.active += 1
      return existing
    }
    return await acquire(key, secret, spec, lease)
  }

  // A fresh build is guarded by `build` itself — `pg-pool.ts` resolves and pins
  // the address there, because the approved address is an input to the driver
  // options and cannot be applied after the fact.
  const value = await spec.build()

  // Whatever is in the map now — `existing`, or one a concurrent acquire built
  // while we awaited — is replaced by this one.
  const previous = entries.get(key)
  if (previous) {
    // The credential was rotated. Drain the old handle in the background, or,
    // when work is still running on it, once the last lease is released.
    entries.delete(key)
    retire(previous)
  }

  const entry: Entry = {
    value,
    destroy: spec.destroy as (value: unknown) => Promise<void>,
    secretHash,
    guardedAt: Date.now(),
    lastUsed: Date.now(),
    active: lease ? 1 : 0,
    retired: false,
  }
  entries.set(key, entry)
  return entry
}

/** End an entry already removed from the map — now, or when its last lease is released. */
function retire(entry: Entry): void {
  entry.retired = true
  if (entry.active === 0) void entry.destroy(entry.value).catch(() => {})
}

/**
 * Drop one handle by key — now, leases or not.
 *
 * The callers are deleting the connection or replacing its credential, where
 * ending queries still running on the old handle is the point. `retired` stays
 * false so a lease released afterwards does not end it a second time.
 */
export async function closeKeyedResource(key: string): Promise<void> {
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  await entry.destroy(entry.value).catch(() => {})
}

function sweep(): void {
  const now = Date.now()

  for (const [key, entry] of entries) {
    if (entry.active === 0 && now - entry.lastUsed > POOL_IDLE_MS) {
      entries.delete(key)
      retire(entry)
    }
  }

  // Busy handles are never candidates, so this can stop above MAX_POOLS when
  // every remaining handle has work running. See the header.
  while (entries.size > MAX_POOLS) {
    let oldest: [string, Entry] | undefined
    for (const entry of entries) {
      if (entry[1].active > 0) continue
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry
    }
    if (!oldest) break
    entries.delete(oldest[0])
    retire(oldest[1])
  }
}
