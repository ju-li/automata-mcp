/**
 * Token-bucket arithmetic for the MCP rate limit, with no I/O and no imports,
 * so it can be exercised in plain Node. mcp-rate-limit.ts keeps the state:
 * in-process here, and the same rules restated in Lua for Redis
 * (`RATE_LIMIT_SCRIPT` there). Change one, change the other.
 *
 * A bucket is "N per minute, up to N at once": capacity N, refilled at N/60 per
 * second. A charge either fits every bucket it names or consumes from none. A
 * token already over its own budget therefore never drains its organization's
 * budget on the way to being refused.
 */

export interface BucketState {
  /** Tokens left at `at`. Fractional; refill is continuous. */
  tokens: number
  /** Milliseconds since the epoch at which `tokens` was true. */
  at: number
}

export interface BucketCharge {
  /** The bucket, e.g. `tok:<tokenId>`. Stable across replicas. */
  key: string
  /** Capacity and refill per minute. Never 0 here: a disabled bucket is not charged. */
  perMinute: number
  /** How many tokens this request takes. Clamped to capacity, so it can always fit eventually. */
  cost: number
}

export interface BucketDecision {
  /** 0 when the charge fits; otherwise milliseconds until every bucket could pay. */
  waitMs: number
  /** Index into the charges of the bucket that needs the longest wait, when refused. */
  limiting?: number
  /** New state per charge: consumed when it fits, refilled-only when refused. */
  next: BucketState[]
}

/** Tokens in a bucket at `now`, given its last state (absent = full). */
export function tokensAt(state: BucketState | undefined, perMinute: number, now: number): number {
  if (!state) return perMinute
  const elapsed = Math.max(0, now - state.at)
  return Math.min(perMinute, state.tokens + elapsed * perMinute / 60_000)
}

/** All-or-nothing: consume `cost` from every bucket, or from none and say how long to wait. */
export function decide(
  states: readonly (BucketState | undefined)[],
  charges: readonly BucketCharge[],
  now: number,
): BucketDecision {
  const available = charges.map((charge, i) => tokensAt(states[i], charge.perMinute, now))

  let waitMs = 0
  let limiting: number | undefined
  charges.forEach((charge, i) => {
    const cost = Math.min(charge.cost, charge.perMinute)
    const short = cost - available[i]!
    if (short <= 0) return
    const wait = Math.ceil(short * 60_000 / charge.perMinute)
    if (wait > waitMs) {
      waitMs = wait
      limiting = i
    }
  })

  const next = charges.map((charge, i) => ({
    tokens: waitMs ? available[i]! : available[i]! - Math.min(charge.cost, charge.perMinute),
    at: now,
  }))
  return { waitMs, limiting, next }
}
