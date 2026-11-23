/**
 * Evolution's own report on one WhatsApp connection (#306): the `health` object
 * `GET /instance/connectionState` answers on the fork from 3.3.0
 * (evolution-api-reforged#68). Parsing and mapping only — no imports, no I/O —
 * so it can be checked in plain Node.
 *
 * **Why it exists.** The app decides whether a connection works by inferring it
 * from outside Evolution: row write times (`rowChurn`), error texts and
 * unacknowledged sends (socket-evidence.ts, send-ack.ts, `socketStalled`), an
 * SQL walk for the newest inbound row (`readLastInbound`). Each has a healthy
 * account that looks the same. Evolution holds the socket and reports these
 * facts directly.
 *
 * **What the report is.** Memory only, empty at process start
 * (`observedSince`), read in the same request as the live state — so it costs
 * nothing extra. Fields this file relies on:
 *
 *   - `verdict`: `ok | reconnecting | looping | stalled | closed`, first match
 *     closed → looping → reconnecting → stalled → ok. `looping` = 3 drops of an
 *     open socket, or 2 conflicts (440), in ten minutes. `stalled` only while
 *     the state reads `open`.
 *   - `reasons`: why, for `looping` and `stalled`.
 *   - `inbound.lastMessageAt`: **arrival** time of the newest message from
 *     someone else, not WhatsApp's timestamp — a backlog delivered after a
 *     reconnect moves it. `null` after a restart until something arrives.
 *   - `reconnects.attempt`: the backoff attempt, 0 when stable.
 *
 * A server without the capability (stock 2.3.7, the fork before 3.3.0, a
 * rollback) answers without `health`, and anything this file cannot read as a
 * report counts as absent — the caller then keeps its own signals. Never
 * "healthy" for lack of a report.
 */

/** The report versions this file reads. 2 = 3.3.0 (`watchdog` added); 1 never shipped in a release. */
const MIN_HEALTH_VERSION = 1

export type HealthVerdict = 'ok' | 'reconnecting' | 'looping' | 'stalled' | 'closed'

const VERDICTS: readonly HealthVerdict[] = ['ok', 'reconnecting', 'looping', 'stalled', 'closed']

/**
 * The part of the report the app reads. The rest (socket times, unacked sends,
 * the watchdog) stays on Evolution's side until something here needs it.
 */
export interface EvolutionHealth {
  version: number
  verdict: HealthVerdict
  /** Short enum strings from the fork (`reconnect_loop`, `ws_closed`, …): no ids, no content. */
  reasons: string[]
  observedSince?: string
  lastInboundAt?: string
  /** Current backoff attempt, 0 when stable. */
  attempt?: number
}

/**
 * The `health` object of a `connectionState` answer, or `undefined` when there
 * is none or it does not read as one: wrong type, unknown verdict, a version
 * below `MIN_HEALTH_VERSION`. A newer version is read as long as the fields
 * here still parse — the fork adds fields, it does not repurpose them.
 */
export function parseEvolutionHealth(raw: unknown): EvolutionHealth | undefined {
  if (!isObject(raw)) return undefined
  const version = raw.version
  if (typeof version !== 'number' || !Number.isFinite(version) || version < MIN_HEALTH_VERSION) return undefined
  const verdict = raw.verdict
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as HealthVerdict)) return undefined

  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((reason): reason is string => typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason))
    : []
  const inbound = isObject(raw.inbound) ? raw.inbound : {}
  const reconnects = isObject(raw.reconnects) ? raw.reconnects : {}

  return {
    version,
    verdict: verdict as HealthVerdict,
    reasons,
    ...optionalTime('observedSince', raw.observedSince),
    ...optionalTime('lastInboundAt', inbound.lastMessageAt),
    ...(typeof reconnects.attempt === 'number' && Number.isFinite(reconnects.attempt) && { attempt: reconnects.attempt }),
  }
}

/** What the app reports, as Evolution's report has it. */
export interface HealthSignals {
  /** A reconnect loop or a session conflict — what `flapping` means. */
  flapping: boolean
  /** The state reads `open` and the socket does not work — what `stalled` means. */
  stalled: boolean
  /**
   * Evolution is retrying a close (backoff attempt above 0, state not `open`).
   * Not `sessionLost`: an unscanned QR pairing retries too, and the report does
   * not say whether the session is linked. Logged beside `sessionLost` only.
   */
  retrying: boolean
  lastInboundAt?: string
}

export function healthSignals(health: EvolutionHealth): HealthSignals {
  return {
    flapping: health.verdict === 'looping',
    stalled: health.verdict === 'stalled',
    retrying: (health.verdict === 'reconnecting' || health.verdict === 'looping') && (health.attempt ?? 0) > 0,
    ...(health.lastInboundAt && { lastInboundAt: health.lastInboundAt }),
  }
}

/**
 * Which signals decide `flapping`, `stalled` and `lastInboundAt` when the server
 * answers `health` (`NUXT_EVOLUTION_HEALTH`):
 *
 *   - `compare` (default): the app's own, as before; Evolution's report is read
 *     and every disagreement logged (`healthDisagreement`). Changes nothing a
 *     user or operator sees — the week of side-by-side logs #306 asks for.
 *   - `use`: Evolution's report; the app's own are still computed and compared.
 *
 * Anything else reads as `compare`: a typo must not change what alerts say.
 */
export type HealthMode = 'compare' | 'use'

export function parseHealthMode(value: unknown): HealthMode {
  return String(value ?? '').trim().toLowerCase() === 'use' ? 'use' : 'compare'
}

/**
 * One line describing where the app's signals and Evolution's disagree, or
 * `undefined` when they agree. Ids and enum values only — the caller adds the
 * connection id.
 */
export function healthDisagreement(
  app: { flapping: boolean, stalled: boolean, sessionLost: boolean },
  health: EvolutionHealth,
  signals: HealthSignals,
): string | undefined {
  const differ: string[] = []
  if (app.flapping !== signals.flapping) differ.push(`flapping app=${app.flapping} evolution=${signals.flapping}`)
  if (app.stalled !== signals.stalled) differ.push(`stalled app=${app.stalled} evolution=${signals.stalled}`)
  if (app.sessionLost !== signals.retrying) differ.push(`sessionLost app=${app.sessionLost} evolution-retrying=${signals.retrying}`)
  if (!differ.length) return undefined

  const reasons = health.reasons.length ? health.reasons.join(',') : 'none'
  return `${differ.join('; ')} (verdict ${health.verdict}, reasons ${reasons}, attempt ${health.attempt ?? '?'}, `
    + `observed since ${health.observedSince ?? '?'})`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An ISO time the report carries, or nothing — never an unparseable string passed on. */
function optionalTime<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  if (typeof value !== 'string') return {}
  const at = Date.parse(value)
  return Number.isNaN(at) ? {} : { [key]: new Date(at).toISOString() } as Record<K, string>
}
