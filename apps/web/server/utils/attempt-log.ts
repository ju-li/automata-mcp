/**
 * Timestamps of attempts per key within a sliding window, bounded in memory
 * without ever letting a caller flush someone else's count. No imports, so
 * test/attempt-log.test.mjs loads it in plain Node. login-throttle.ts keeps its
 * sign-in, code and reset caps in these.
 *
 * Rules easy to undo:
 *
 * - **Eviction never picks by insertion order.** The old maps dropped their
 *   oldest key once over 10 000 — and the oldest key is the victim's, the one
 *   that has been counting longest. A stranger with made-up addresses reset the
 *   per-account password cap, the code caps and the daily reset cap that way.
 *   Here expired keys go first, then the keys with the fewest attempts (a
 *   flood of new keys holds one each), and **a key at its limit is never
 *   evicted** until `hardCap` — which only many keys each pushed to the limit
 *   can reach, at `limit` attempts apiece.
 * - **A read is correct without a sweep.** `recent` filters the one key it is
 *   asked about; the sweep only reclaims memory, so running it rarely cannot
 *   over- or under-count.
 * - **Evict in batches, never per request.** Over `softCap`, one pass evicts
 *   down to 90% of it (or of `hardCap` when only blocked keys are left), and
 *   the next pass waits until the log has grown another 10% — so a flood pays
 *   one sort per ~10% of the cap, even when nothing evictable remains.
 */

export interface AttemptLogOptions {
  /** How long an attempt counts. */
  windowMs: number
  /** Attempts at which a key is blocked: never evicted below `hardCap`. */
  limit: number
  /** Keys kept before eviction starts. */
  softCap: number
  /** Absolute ceiling: past it even blocked keys go, oldest activity first. */
  hardCap: number
}

export class AttemptLog {
  private readonly attempts = new Map<string, number[]>()
  private readonly options: AttemptLogOptions
  /** Size past which `add` runs the next eviction pass. */
  private evictAbove: number

  constructor(options: AttemptLogOptions) {
    this.options = options
    this.evictAbove = options.softCap
  }

  get size(): number {
    return this.attempts.size
  }

  /** Attempts on `key` still inside the window at `now`, oldest first. Stores the trimmed list. */
  recent(key: string, now: number): number[] {
    const times = this.attempts.get(key)
    if (!times) return []
    const recent = times.filter(at => now - at < this.options.windowMs)
    if (recent.length) this.attempts.set(key, recent)
    else this.attempts.delete(key)
    return recent
  }

  /** When `key` may try again, or 0 when it is under the limit now. */
  blockedUntil(key: string, now: number): number {
    const { limit, windowMs } = this.options
    const recent = this.recent(key, now)
    if (recent.length < limit) return 0
    return recent[recent.length - limit]! + windowMs
  }

  add(key: string, at: number): void {
    this.attempts.set(key, [...this.recent(key, at), at])
    if (this.attempts.size > this.evictAbove) this.evict(at)
  }

  /** Hand back one attempt timestamped `at`. Equal timestamps are interchangeable. */
  drop(key: string, at: number): void {
    const times = this.attempts.get(key)
    const index = times?.indexOf(at) ?? -1
    if (index < 0) return
    times!.splice(index, 1)
    if (!times!.length) this.attempts.delete(key)
  }

  delete(key: string): void {
    this.attempts.delete(key)
  }

  private evict(now: number): void {
    const { windowMs, limit, softCap, hardCap } = this.options
    for (const [key, times] of this.attempts) {
      if (!times.some(at => now - at < windowMs)) this.attempts.delete(key)
    }
    const headroom = Math.ceil(softCap * 0.1)
    const newest = (times: number[]) => times[times.length - 1] ?? 0

    // Under the limit, fewest attempts first: a flood's keys hold one each.
    const target = Math.floor(softCap * 0.9)
    if (this.attempts.size > target) {
      const evictable = [...this.attempts]
        .filter(([, times]) => times.length < limit)
        .sort(([, a], [, b]) => a.length - b.length || newest(a) - newest(b))
      for (const [key] of evictable) {
        if (this.attempts.size <= target) break
        this.attempts.delete(key)
      }
    }

    // Blocked keys only when the rest could not make `headroom` of room under
    // the ceiling — else every new key past it would start another full pass.
    const ceiling = Math.min(Math.floor(hardCap * 0.9), hardCap - headroom)
    if (this.attempts.size > hardCap - headroom) {
      const byActivity = [...this.attempts].sort(([, a], [, b]) => newest(a) - newest(b))
      for (const [key] of byActivity) {
        if (this.attempts.size <= ceiling) break
        this.attempts.delete(key)
      }
    }

    // At least `headroom` new keys before the next pass, never past `hardCap`.
    this.evictAbove = Math.min(hardCap, Math.max(softCap, this.attempts.size + headroom))
  }
}

/**
 * The part of a client address a throttle counts on. An IPv6 client usually
 * holds a whole /64, so keying on the full address hands it unlimited fresh
 * keys; it is counted as its /64 instead. IPv4 — including IPv4-mapped IPv6 —
 * stays whole. Anything unparseable is returned as is.
 */
export function throttleAddress(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]!
  if (!ip.includes(':')) return ip
  const bare = ip.split('%')[0]!
  const halves = bare.split('::')
  if (halves.length > 2) return ip
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return ip
  const groups = [...head, ...Array(missing).fill('0'), ...tail]
  if (!groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) return ip
  return `${groups.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/64`
}
