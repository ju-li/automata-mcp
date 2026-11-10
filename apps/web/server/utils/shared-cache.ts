import { Redis } from 'ioredis'

/**
 * Short-lived caches that several replicas can share — through Redis when
 * `NUXT_REDIS_URL` is set, in-process otherwise.
 *
 * **Optional, and never a failure mode.** Redis is not on every install: compose
 * runs it only under the `whatsapp` profile, for Evolution, and older templates
 * have none the app could use. So:
 *
 *   unset               in-process, per replica — what every self-hosted
 *                       install gets. One line at boot says so.
 *   set, unreachable    in-process, and logged (at most once a minute). Never a
 *                       503: a cache that cannot be reached is a slower answer,
 *                       not a missing one.
 *   set, reachable      shared across replicas and kept across deploys.
 *
 * **Rules for what goes in, since an operator may point this at a Redis that
 * also serves something else** (on another database number — never Evolution's
 * `/6`): every key carries the `automata:v1:` prefix and a TTL, values stay
 * small (over `MAX_VALUE_BYTES` is kept in-process only), and nothing here runs
 * `FLUSH*`, `CONFIG` or `KEYS`. No credentials, DSNs or message content are ever
 * cached here — values are identifiers and timestamps a listing is made of.
 * The URL can carry a password, so it is never logged; neither is a value.
 *
 * **Single-flight is in-process.** Concurrent callers on one replica share one
 * load; two replicas missing at the same moment each load once. That is still
 * one read per replica per window rather than one per call, and a cross-replica
 * lock would put a Redis round trip and its failure modes in front of every miss.
 *
 * **Failures are never cached.** `load` throwing reaches every caller waiting on
 * it, and the next call loads again. A caller that wants a failure remembered
 * has `staleWhileFailing` in `lookup-cache.ts`.
 */

const KEY_PREFIX = 'automata:v1:'
/** Above this a value is kept in-process only — the rule is "stays small". */
const MAX_VALUE_BYTES = 2 * 1024 * 1024
/** Redis has this long to answer a read before the caller loads it itself. */
const COMMAND_TIMEOUT_MS = 500
const PROBLEM_LOG_EVERY_MS = 60_000

export interface SharedCacheOptions {
  /** Part of every key, so two caches can never read each other's values. */
  namespace: string
  /** How long a value is served for, in both layers. */
  ttlMs: number
  /** In-process entries kept, oldest dropped first. */
  maxLocalEntries?: number
}

export interface SharedCache<T> {
  /** The cached value for `key`, or `load()`'s, stored for `ttlMs`. Throws only what `load` throws. */
  get: (key: string, load: () => Promise<T>) => Promise<T>
  /** Drop `key` from both layers — for a change that must show before the TTL runs out. */
  forget: (key: string) => void
}

/** What is stored in Redis: the expiry travels with the value so every replica's memo agrees. */
interface Envelope<T> {
  expiresAt: number
  value: T
}

export function sharedCache<T>(options: SharedCacheOptions): SharedCache<T> {
  const local = new Map<string, Envelope<T>>()
  const inFlight = new Map<string, Promise<T>>()
  const maxLocal = options.maxLocalEntries ?? 500

  function remember(key: string, entry: Envelope<T>) {
    local.delete(key)
    local.set(key, entry)
    if (local.size <= maxLocal) return
    const now = Date.now()
    for (const [k, e] of local) {
      if (e.expiresAt <= now) local.delete(k)
    }
    // Insertion order is age order, since `remember` re-inserts.
    while (local.size > maxLocal) local.delete(local.keys().next().value!)
  }

  async function refresh(key: string, load: () => Promise<T>): Promise<T> {
    const redisKey = `${KEY_PREFIX}${options.namespace}:${key}`

    const shared = await redisGet<Envelope<T>>(redisKey)
    if (shared && shared.expiresAt > Date.now()) {
      remember(key, shared)
      return shared.value
    }

    const value = await load()
    const entry = { expiresAt: Date.now() + options.ttlMs, value }
    remember(key, entry)
    redisSet(redisKey, entry, options.ttlMs)
    return value
  }

  return {
    get(key, load) {
      const cached = local.get(key)
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)

      let pending = inFlight.get(key)
      if (!pending) {
        pending = refresh(key, load).finally(() => inFlight.delete(key))
        inFlight.set(key, pending)
      }
      return pending
    },

    forget(key) {
      local.delete(key)
      const client = readyClient()
      if (!client) return
      client.del(`${KEY_PREFIX}${options.namespace}:${key}`).catch(error => reportProblem('delete', error))
    },
  }
}

// ---------------------------------------------------------------------------
// The one client, created on first use from NUXT_REDIS_URL.

/** `undefined`: not decided yet. `null`: not configured. */
let client: Redis | null | undefined
let lastProblemLoggedAt = 0
/** Connected right now — so a `close` is an outage worth one line. */
let connected = false
/** Ever connected in this process — so the next `ready` is a reconnect. */
let everConnected = false

/** Whether `NUXT_REDIS_URL` is set. Says nothing about whether Redis answers. */
export function sharedCacheConfigured(): boolean {
  return Boolean(redisUrl())
}

function redisUrl(): string {
  return String(useRuntimeConfig().redisUrl ?? '').trim()
}

/**
 * Create the client (and start connecting) if configured. Idempotent; the boot
 * plugin calls it so a bad URL shows in the log before the first request.
 */
export function startSharedCache(): Redis | undefined {
  if (client !== undefined) return client ?? undefined

  const url = redisUrl()
  if (!url) {
    client = null
    return undefined
  }

  let created: Redis
  try {
    created = new Redis(url, {
      lazyConnect: true,
      // Commands while disconnected fail at once instead of queueing: the caller
      // falls back to loading, rather than waiting on a Redis that is not there.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectionName: 'automata-web',
      // Keep trying in the background, gently; never give up for good.
      retryStrategy: times => Math.min(times * 1_000, 30_000),
    })
  }
  catch (error) {
    // A URL ioredis cannot parse. Not fatal — caches stay in-process.
    client = null
    console.error('[redis] NUXT_REDIS_URL could not be used; caches stay in-process:', describe(error))
    return undefined
  }

  created.on('error', error => reportProblem('connection', error))
  created.on('ready', () => {
    if (everConnected) console.info('[redis] reconnected; caches shared again.')
    else console.info('[redis] connected; caches are shared across replicas.')
    connected = true
    everConnected = true
  })
  created.on('close', () => {
    // Once per outage, and not for our own shutdown.
    if (connected && client === created) console.warn('[redis] connection lost; using in-process caches until it returns.')
    connected = false
  })
  created.connect().catch(error => reportProblem('connection', error))

  client = created
  return created
}

/** Close the client on shutdown. */
export async function stopSharedCache(): Promise<void> {
  const current = client
  client = undefined
  if (!current) return
  try {
    await current.quit()
  }
  catch {
    current.disconnect()
  }
}

function readyClient(): Redis | undefined {
  const current = startSharedCache()
  return current?.status === 'ready' ? current : undefined
}

async function redisGet<V>(key: string): Promise<V | undefined> {
  const current = readyClient()
  if (!current) return undefined
  try {
    const raw = await current.get(key)
    return raw === null ? undefined : JSON.parse(raw) as V
  }
  catch (error) {
    reportProblem('read', error)
    return undefined
  }
}

function redisSet(key: string, value: unknown, ttlMs: number): void {
  const current = readyClient()
  if (!current) return

  let raw: string
  try {
    raw = JSON.stringify(value)
  }
  catch (error) {
    reportProblem('encode', error)
    return
  }
  if (Buffer.byteLength(raw) > MAX_VALUE_BYTES) return

  current.set(key, raw, 'PX', Math.max(1, Math.round(ttlMs))).catch(error => reportProblem('write', error))
}

/** One line a minute at most: a Redis that is down errors on every attempt. */
function reportProblem(what: string, error: unknown) {
  const now = Date.now()
  if (now - lastProblemLoggedAt < PROBLEM_LOG_EVERY_MS) return
  lastProblemLoggedAt = now
  console.warn(`[redis] ${what} failed; using in-process caches meanwhile:`, describe(error))
}

/** The message only — an error object could carry connection options. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
