import type { AppInstance } from './app-db'
import type { InboundGapBand, LastInbound } from './evolution-db'
import type { ConnectionState } from '#shared/connection'

/**
 * Inbound silence (#238): a WhatsApp account that reads `open` — live and
 * stored, no churn, no dead-socket evidence — and still stops receiving.
 *
 * Production, Nov 14–15 2026: one busy account (50–200 inbound an hour) went
 * fourteen hours without a live inbound message while every other signal said
 * healthy. `stalled` learns only from a failed socket call, and sends kept
 * answering 200; `flapping` needs reopenings ten minutes apart. The one thing
 * the failure showed was the thing nothing looked at: messages stopped
 * arriving.
 *
 * **Judged against the account's own history, never a fixed threshold.**
 * Arrivals are close to random, so a quiet hour is routine for a small account
 * and impossible for a busy one. Each account's gaps between received messages
 * over the past `HISTORY_DAYS` are measured per band — weekday or weekend, four
 * hours of the day, in `NUXT_WHATSAPP_SILENCE_TIME_ZONE` — and the live silence
 * is compared with the 99.9th percentile gap of the band the last message
 * arrived in, floored at `FLOOR_MS`. Nights, weekends and lunch breaks raise
 * their own bands' thresholds by themselves.
 *
 * **Busy bands only.** A band below `MIN_PER_HOUR` received messages an hour,
 * with fewer than `MIN_GAPS` gaps, or an account with under `MIN_HISTORY_DAYS`
 * of history is never judged: silence there says nothing. Those accounts still
 * show `lastInboundAt` (#240), which is the honest answer for them.
 *
 * **Fleet rule.** Several busy accounts on one Evolution server past their 99th
 * percentile at once is what a server-wide failure looks like, and unlikely by
 * chance; then each of them is silent at the lower bar. One account alone still
 * needs the 99.9th.
 *
 * **Same read as the dashboard.** The silence is `readLastInbound` (via the
 * 60 s `cachedLastInbound`), and the baseline (`readInboundGaps`) counts the
 * same rows — inbound, not `status@broadcast`, not control records, by
 * WhatsApp's `messageTimestamp`. A redelivered backlog keeps its old
 * timestamps, so it neither looks like traffic nor resets a baseline.
 *
 * **Ends only on a live message**: one stamped within `FLOOR_MS` of now. Not on
 * the last-received time moving: in the incident each socket reopen delivered a
 * burst of 13-hour-old backlog, which moved it by minutes while the account was
 * as deaf as before. Never on a reopen or a send answered 200.
 *
 * **`NUXT_WHATSAPP_SILENCE_ALERTS`** = `off` | `shadow` (default) | `on`.
 * Shadow: episodes are recorded on the row, logged with the rule and threshold
 * that fired, and mailed to `NUXT_OPS_ALERT_EMAIL` (our Evolution only) — and
 * nothing else: no customer mail, no dashboard, no MCP field. That is the data
 * the `on` settings get chosen from. On: also unhealthy in
 * `evaluateConnectionHealth`, `silent` on `InstanceStatus`, operator report
 * through `reportLoopToOperator`.
 *
 * No message database, no timestamp index, unknown last-received: never judged.
 */

export type SilenceMode = 'off' | 'shadow' | 'on'

/** What fired, and against what. Stored on `app.instances.silent_detail`. */
export interface SilenceDetail {
  /** `account`: past its own 99.9th percentile. `fleet`: past its 99th, with others on its server. */
  rule: 'account' | 'fleet'
  thresholdMs: number
  silenceMs: number
  /** e.g. `weekday 12:00–16:00 America/Sao_Paulo`. */
  band: string
  /** The newest inbound message when judged; absent: none in the 7-day window. */
  lastInboundAt?: string
  judgedAt: string
}

/** One band of a stored baseline. */
interface SilenceBand {
  weekend: boolean
  band: number
  gaps: number
  perHour: number
  p99Ms: number
  p999Ms: number
}

interface SilenceBaseline {
  timeZone: string
  historyDays?: number
  bands: SilenceBand[]
}

/** How much history a baseline is measured over. */
const HISTORY_MS = 28 * 24 * 60 * 60_000
/** Less history than this and the account is never judged. */
const MIN_HISTORY_DAYS = 14
/** Silence shorter than this is never silent, and a message newer than it ends an episode. */
const FLOOR_MS = 45 * 60_000
/**
 * The fleet rule's own floor, lower than `FLOOR_MS`: for a busy account both
 * percentiles sit far below 45 min, so a shared floor would make the fleet rule
 * identical to the single-account one. Several busy accounts on one server each
 * this far past their own 99th percentile at once is not chance.
 */
const FLEET_FLOOR_MS = 20 * 60_000
/** A band receiving fewer messages an hour than this is never judged. */
const MIN_PER_HOUR = 10
/** ...nor one with fewer gaps measured than this — a 99.9th percentile of 50 is the maximum. */
const MIN_GAPS = 200
/** Fleet rule: at least this many busy accounts on one server past their 99th… */
const FLEET_MIN = 3
/** …and at least this share of the busy accounts judged there. */
const FLEET_SHARE = 0.2
/** How long one account's observation counts toward its server's fleet verdict. */
const OBSERVATION_TTL_MS = 15 * 60_000
/** A baseline older than this is recomputed. */
const BASELINE_MAX_AGE_MS = 23 * 60 * 60_000
/** After a failed or impossible computation, wait this long before trying again. */
const BASELINE_RETRY_MS = 60 * 60_000
/** A computation's lease; longer than its own deadline. */
const BASELINE_LEASE_MS = 10 * 60_000
/** Baselines computed per run, one at a time — the first runs after deploy fill in over hours. */
const BASELINES_PER_RUN = 30
/** How long a baseline read from the app DB serves the sweep. */
const BASELINE_CACHE_MS = 10 * 60_000

// ── settings ───────────────────────────────────────────────────────────────

let modeWarned = false

/** `NUXT_WHATSAPP_SILENCE_ALERTS`. Unknown values read as `shadow`: a typo must not mail customers. */
export function silenceAlertMode(): SilenceMode {
  const raw = String(useRuntimeConfig().whatsappSilenceAlerts ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === 'shadow' || raw === 'on') return raw
  if (raw && !modeWarned) {
    modeWarned = true
    console.warn(`[silence] NUXT_WHATSAPP_SILENCE_ALERTS="${raw}" is not off, shadow or on; using shadow.`)
  }
  return 'shadow'
}

let zoneWarned = false

/** `NUXT_WHATSAPP_SILENCE_TIME_ZONE`, an IANA name; `UTC` when unset or not one. */
export function silenceTimeZone(): string {
  const raw = String(useRuntimeConfig().whatsappSilenceTimeZone ?? '').trim()
  if (!raw) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw })
    return raw
  }
  catch {
    if (!zoneWarned) {
      zoneWarned = true
      console.warn(`[silence] NUXT_WHATSAPP_SILENCE_TIME_ZONE="${raw}" is not a time zone; using UTC.`)
    }
    return 'UTC'
  }
}

// ── baselines ──────────────────────────────────────────────────────────────

/**
 * Recompute stale baselines. Registered as the hourly `whatsapp:silence-baselines`
 * task. Leased per row (conditional upsert), so replicas take turns rather than
 * repeat a 28-day read; at most `BASELINES_PER_RUN`, one at a time, each bounded.
 *
 * Paired WhatsApp connections that can read messages only. An account whose
 * database lacks `message_instance_ts_idx` answers `undefined` and is retried
 * after `BASELINE_RETRY_MS`, like a failure.
 */
export async function refreshSilenceBaselines(): Promise<{ computed: number, failed: number }> {
  if (silenceAlertMode() === 'off') return { computed: 0, failed: 0 }

  const sql = await appDb()
  const timeZone = silenceTimeZone()
  const candidates = await sql<AppInstance[]>`
    SELECT i.* FROM app.instances i
    LEFT JOIN app.whatsapp_silence_baselines b ON b.instance_id = i.id
    WHERE i.kind = 'whatsapp' AND i.paired_at IS NOT NULL
      AND (b.instance_id IS NULL OR (
        b.lease_until < now()
        AND (b.computed_at IS NULL OR b.computed_at < now() - ${BASELINE_MAX_AGE_MS / 1000} * interval '1 second'
             OR b.time_zone <> ${timeZone})))
    ORDER BY b.computed_at NULLS FIRST, i.created
  `
  const due = candidates.filter(instance => canReadMessages(instance)).slice(0, BASELINES_PER_RUN)

  let computed = 0
  let failed = 0
  await forEachBounded(due, {
    concurrency: 1,
    deadlineMs: INBOUND_GAPS_TIMEOUT_MS + 30_000,
    what: instance => `computing connection ${instance.id}'s silence baseline`,
    onError: (instance, error) => {
      failed++
      console.error(`[silence] could not compute connection ${instance.id}'s baseline:`, error)
      void retryLater(instance.id)
    },
  }, async (instance) => {
    if (await computeBaseline(instance, timeZone)) computed++
  })
  return { computed, failed }
}

async function computeBaseline(instance: AppInstance, timeZone: string): Promise<boolean> {
  const sql = await appDb()
  const claimed = await sql`
    INSERT INTO app.whatsapp_silence_baselines AS b (instance_id, lease_until)
    VALUES (${instance.id}, now() + ${BASELINE_LEASE_MS / 1000} * interval '1 second')
    ON CONFLICT (instance_id) DO UPDATE SET lease_until = EXCLUDED.lease_until
    WHERE b.lease_until < now()
      AND (b.computed_at IS NULL OR b.computed_at < now() - ${BASELINE_MAX_AGE_MS / 1000} * interval '1 second'
           OR b.time_zone <> ${timeZone})
    RETURNING b.instance_id
  `
  if (!claimed.length) return false

  const now = Date.now()
  const gaps = await readInboundGaps(instance, { sinceMs: now - HISTORY_MS, untilMs: now, timeZone })
  if (!gaps) {
    await retryLater(instance.id)
    return false
  }

  const bands: SilenceBand[] = gaps.bands.map(band => toSilenceBand(band))
  await sql`
    UPDATE app.whatsapp_silence_baselines
    SET computed_at = now(), lease_until = '-infinity', time_zone = ${timeZone},
        history_days = ${gaps.historyDays ?? null}, bands = ${sql.json(bands as never)}
    WHERE instance_id = ${instance.id}
  `
  baselineCache.delete(instance.id)
  return true
}

function toSilenceBand(band: InboundGapBand): SilenceBand {
  return {
    weekend: band.weekend,
    band: band.band,
    gaps: band.gaps,
    perHour: band.hours > 0 ? band.gaps / band.hours : 0,
    p99Ms: band.p99 * 1000,
    p999Ms: band.p999 * 1000,
  }
}

async function retryLater(instanceId: string): Promise<void> {
  try {
    const sql = await appDb()
    await sql`
      UPDATE app.whatsapp_silence_baselines
      SET lease_until = now() + ${BASELINE_RETRY_MS / 1000} * interval '1 second'
      WHERE instance_id = ${instanceId}
    `
  }
  catch (error) {
    console.error(`[silence] could not postpone connection ${instanceId}'s baseline:`, error)
  }
}

const baselineCache = new Map<string, { at: number, value: SilenceBaseline | undefined }>()

async function baselineFor(instanceId: string): Promise<SilenceBaseline | undefined> {
  const cached = baselineCache.get(instanceId)
  if (cached && Date.now() - cached.at < BASELINE_CACHE_MS) return cached.value

  const sql = await appDb()
  const [row] = await sql<Array<{ time_zone: string, history_days?: number, bands: SilenceBand[] }>>`
    SELECT time_zone, history_days, bands FROM app.whatsapp_silence_baselines
    WHERE instance_id = ${instanceId} AND computed_at IS NOT NULL
  `
  const value = row
    ? { timeZone: row.time_zone, historyDays: row.history_days ?? undefined, bands: Array.isArray(row.bands) ? row.bands : [] }
    : undefined
  baselineCache.set(instanceId, { at: Date.now(), value })
  return value
}

// ── judging ────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Weekday/weekend and four-hour band of a moment, in `timeZone` — the SQL's `isodow` and `hour / 4`. */
export function silenceBandOf(ms: number, timeZone: string): { weekend: boolean, band: number } {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    formatters.set(timeZone, format)
  }
  const parts = format.formatToParts(new Date(ms))
  const weekday = parts.find(part => part.type === 'weekday')?.value
  const hour = Number(parts.find(part => part.type === 'hour')?.value) % 24
  return { weekend: weekday === 'Sat' || weekday === 'Sun', band: Math.floor(hour / 4) }
}

function bandLabel(key: { weekend: boolean, band: number }, timeZone: string): string {
  const from = String(key.band * 4).padStart(2, '0')
  const to = String(key.band * 4 + 4).padStart(2, '0')
  return `${key.weekend ? 'weekend' : 'weekday'} ${from}:00–${to}:00 ${timeZone}`
}

/** Which of a baseline's bands may be judged at all. */
function judgeableBand(baseline: SilenceBaseline, key: { weekend: boolean, band: number }): SilenceBand | undefined {
  if ((baseline.historyDays ?? 0) < MIN_HISTORY_DAYS) return undefined
  const band = baseline.bands.find(b => b.weekend === key.weekend && b.band === key.band)
  if (!band || band.gaps < MIN_GAPS || band.perHour < MIN_PER_HOUR) return undefined
  return band
}

/**
 * The fleet rule's memory: per process, the latest observation of each busy
 * account — which server it is on and whether it is past its 99th percentile.
 * Filled by every judgement (sweep and webhook alike), so a server's verdict
 * lags by at most one sweep. Several replicas each keep their own; the sweep
 * visits every connection in each, so each sees the whole server.
 */
const observations = new Map<string, { server: string, overP99: boolean, at: number }>()

function serverKey(instance: AppInstance): string {
  return onDeploymentServer(instance) ? 'deployment' : `byo:${instance.base_url ?? ''}`
}

function fleetSilent(server: string, now: number): boolean {
  let judged = 0
  let over = 0
  for (const [id, seen] of observations) {
    if (now - seen.at > OBSERVATION_TTL_MS) {
      observations.delete(id)
      continue
    }
    if (seen.server !== server) continue
    judged++
    if (seen.overP99) over++
  }
  return over >= Math.max(FLEET_MIN, Math.ceil(FLEET_SHARE * judged))
}

/** Only what the judgement needs of a live health read. */
export interface SilenceHealth {
  state: ConnectionState
  sessionLost: boolean
  flapping: boolean
  stalled: boolean
}

interface Verdict {
  silent: boolean
  detail?: SilenceDetail
  lastInbound?: LastInbound
}

/**
 * Is this account silent right now? Judged only when it reads healthy by every
 * other signal — a dropped, looping or stuck account is already reported, and
 * its silence is expected — and when the band its last message arrived in is a
 * busy one.
 */
async function judge(instance: AppInstance, health: SilenceHealth, now: number): Promise<Verdict> {
  const quiet = { silent: false }
  if (!otherwiseHealthy(health)) {
    observations.delete(instance.id)
    return quiet
  }
  if (!canReadMessages(instance)) return quiet

  const baseline = await baselineFor(instance.id)
  if (!baseline || baseline.timeZone !== silenceTimeZone()) return quiet
  if (!baseline.bands.some(band => judgeableBand(baseline, band))) return quiet

  const lastInbound = await cachedLastInbound(instance)
  if (!lastInbound) return quiet
  const lastAt = Date.parse(lastInbound.at ?? lastInbound.since)
  if (Number.isNaN(lastAt)) return { ...quiet, lastInbound }

  const key = silenceBandOf(lastAt, baseline.timeZone)
  const band = judgeableBand(baseline, key)
  if (!band) {
    observations.delete(instance.id)
    return { ...quiet, lastInbound }
  }

  const silenceMs = Math.max(0, now - lastAt)
  const accountThreshold = Math.max(FLOOR_MS, band.p999Ms)
  const fleetThreshold = Math.max(FLEET_FLOOR_MS, band.p99Ms)
  const server = serverKey(instance)
  const overP99 = silenceMs > fleetThreshold
  observations.set(instance.id, { server, overP99, at: now })

  const rule = silenceMs > accountThreshold
    ? 'account'
    : overP99 && fleetSilent(server, now) ? 'fleet' : undefined
  if (!rule) return { ...quiet, lastInbound }

  return {
    silent: true,
    lastInbound,
    detail: {
      rule,
      thresholdMs: rule === 'account' ? accountThreshold : fleetThreshold,
      silenceMs,
      band: bandLabel(key, baseline.timeZone),
      ...(lastInbound.at && { lastInboundAt: lastInbound.at }),
      judgedAt: new Date(now).toISOString(),
    },
  }
}

/**
 * Judge one WhatsApp connection and keep its episode on the row: start it when
 * judged silent, end it on a live inbound message. Called by the alert sweep
 * and webhook evaluation, after the health read (alerts.ts). Answers whether
 * the connection counts as `silent` for health — only ever true in `on` mode.
 *
 * Shadow mode mails the operator here, once per episode (`silence_ops_mailed_at`,
 * claimed before sending, released on failure). In `on` mode the operator hears
 * through `reportLoopToOperator` instead, as for `stalled`.
 *
 * Never throws into the sweep: a failure is logged and counts as not silent.
 */
export async function assessSilence(instance: AppInstance, health: SilenceHealth): Promise<boolean> {
  try {
    return await assess(instance, health) && silenceAlertMode() === 'on' && otherwiseHealthy(health)
  }
  catch (error) {
    console.error(`[silence] could not judge connection ${instance.id}:`, error)
    return false
  }
}

async function assess(instance: AppInstance, health: SilenceHealth): Promise<boolean> {
  const mode = silenceAlertMode()
  const sql = await appDb()

  if (mode === 'off') {
    if (instance.silent_since) {
      await sql`
        UPDATE app.instances SET silent_since = NULL, silent_detail = NULL, silence_ops_mailed_at = NULL
        WHERE id = ${instance.id}
      `
    }
    return false
  }

  const now = Date.now()
  const verdict = await judge(instance, health, now)

  if (!instance.silent_since) {
    if (!verdict.silent || !verdict.detail) return false
    const started = await sql`
      UPDATE app.instances SET silent_since = now(), silent_detail = ${sql.json(verdict.detail as never)}
      WHERE id = ${instance.id} AND silent_since IS NULL
      RETURNING id
    `
    if (!started.length) return mode === 'on'
    console.warn(
      `[silence] ${mode}: WhatsApp connection ${instance.id} (Evolution instance "${instance.name}") stopped receiving — `
      + describeDetail(verdict.detail),
    )
    if (mode === 'shadow') await mailOperatorShadow(instance, verdict.detail)
    return mode === 'on'
  }

  // An episode is open. It ends on a live message and nothing else.
  const lastInbound = verdict.lastInbound ?? await cachedLastInbound(instance)
  const lastAt = lastInbound?.at ? Date.parse(lastInbound.at) : Number.NaN
  if (!Number.isNaN(lastAt) && now - lastAt < FLOOR_MS) {
    // The mail flag as read with the row: the sweep's read is fresh enough to
    // decide whether the operator heard the start, and so should hear the end.
    const ended = await sql`
      UPDATE app.instances SET silent_since = NULL, silent_detail = NULL, silence_ops_mailed_at = NULL
      WHERE id = ${instance.id} AND silent_since IS NOT NULL
      RETURNING id
    `
    if (ended.length) {
      const lasted = Math.round((now - Date.parse(instance.silent_since)) / 60_000)
      console.info(
        `[silence] ${mode}: WhatsApp connection ${instance.id} is receiving again — live inbound at ${lastInbound!.at}, `
        + `episode lasted ${lasted} min (since ${instance.silent_since}, rule ${instance.silent_detail?.rule ?? 'unknown'}).`,
      )
      if (mode === 'shadow' && instance.silence_ops_mailed_at) await mailOperatorShadowEnded(instance, lastInbound!.at!)
    }
    return false
  }

  // Still silent. A shadow mail that failed to send is retried here.
  if (mode === 'shadow' && !instance.silence_ops_mailed_at && instance.silent_detail) {
    await mailOperatorShadow(instance, instance.silent_detail)
  }
  return mode === 'on'
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`
}

function describeDetail(detail: SilenceDetail): string {
  return `rule ${detail.rule}, silent ${minutes(detail.silenceMs)} against a threshold of ${minutes(detail.thresholdMs)} `
    + `(${detail.rule === 'account' ? `99.9th percentile gap, floor ${minutes(FLOOR_MS)}` : `99th percentile gap, floor ${minutes(FLEET_FLOOR_MS)}, with other busy accounts on its server`}), `
    + `band ${detail.band}, last inbound ${detail.lastInboundAt ?? 'none in 7 days'}.`
}

/**
 * Shadow mode's only reader: the operator, our Evolution only (the same rule as
 * a loop's mail, `operatorMailedAboutLoops`). Ids only, as there.
 */
async function mailOperatorShadow(instance: AppInstance, detail: SilenceDetail): Promise<void> {
  if (!operatorMailedAboutLoops(instance)) return
  const sql = await appDb()
  const claimed = await sql`
    UPDATE app.instances SET silence_ops_mailed_at = now()
    WHERE id = ${instance.id} AND silent_since IS NOT NULL AND silence_ops_mailed_at IS NULL
    RETURNING id
  `
  if (!claimed.length) return

  const sent = await sendAppEmail({
    to: String(useRuntimeConfig().opsAlertEmail).trim(),
    subject: `[shadow] WhatsApp connection ${instance.id} stopped receiving`,
    text: [
      `WhatsApp connection ${instance.id} (Evolution instance "${instance.name}", organization ${instance.org || 'unknown'}) `
      + 'reads open, with no reconnect loop and no dead-socket evidence, but has received nothing for far longer '
      + 'than its own history says is normal.',
      '',
      describeDetail(detail),
      '',
      'Shadow mode (NUXT_WHATSAPP_SILENCE_ALERTS=shadow): its users are not told, and nothing shows on the dashboard '
      + 'or over MCP. If this is real, restarting the Evolution service is the known fix (no QR scan needed). '
      + 'If it is not, note it: these episodes are what the settings for "on" are chosen from.',
      '',
      'See docs/whatsapp.md, "Stopped receiving". You will get one more email when a live message arrives.',
    ].join('\n'),
  })
  if (!sent) await sql`UPDATE app.instances SET silence_ops_mailed_at = NULL WHERE id = ${instance.id}`
}

async function mailOperatorShadowEnded(instance: AppInstance, lastInboundAt: string): Promise<void> {
  const to = String(useRuntimeConfig().opsAlertEmail ?? '').trim()
  if (!to) return
  await sendAppEmail({
    to,
    subject: `[shadow] WhatsApp connection ${instance.id} is receiving again`,
    text: `WhatsApp connection ${instance.id} (Evolution instance "${instance.name}") received a live message at `
      + `${lastInboundAt}. The silence episode that began ${instance.silent_since} has ended.`,
  })
}

/**
 * Whether a status read should report `silent`: `on` mode, an episode open on
 * the row, and nothing stronger to report — `flapping` and `stalled` name the
 * same fix, a dropped session a different one. The row, not a fresh judgement:
 * the sweep is the one judge, so the dashboard and MCP cannot disagree with the
 * mail.
 */
export function reportsSilent(
  instance: Pick<AppInstance, 'silent_since'>,
  health: SilenceHealth,
): boolean {
  return silenceAlertMode() === 'on' && Boolean(instance.silent_since) && otherwiseHealthy(health)
}

/** Nothing stronger to report: silence under a drop, a loop or a dead socket is expected. */
function otherwiseHealthy(health: SilenceHealth): boolean {
  return health.state === 'open' && !health.sessionLost && !health.flapping && !health.stalled
}
