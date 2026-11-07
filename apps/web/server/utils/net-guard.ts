import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * Refuse a user-supplied network target that resolves inside our own perimeter.
 *
 * **Why this exists.** Until connections were polymorphic, every outbound address
 * this app used came from its own configuration. Now a user types one: a Postgres
 * DSN, or the base URL of their own Evolution server. A DSN of
 * `postgres://…@127.0.0.1:5432/evolution` — or, on the compose network,
 * `postgres://…@postgres:5432/evolution` — reaches the database holding *every*
 * user's WhatsApp messages, which `evolution-db.ts` already describes as far
 * wider than anything else the app holds. `http://evolution:8080` with a guessed
 * global key is the same attack against the API. Neither is exotic; both are one
 * paste into a form.
 *
 * This is the same shape of risk as the admin-key fallback that
 * `credentialsForInstance()` refuses, and it gets the same treatment: one
 * function, no convenience path around it, and both user-supplied targets go
 * through it so the two cannot drift.
 *
 * **Two independent checks**, because either alone has a hole:
 *
 *   1. Address class — reject loopback, private, link-local, CGNAT and friends.
 *      Turned off wholesale by `NUXT_ALLOW_PRIVATE_TARGETS`, which a
 *      single-tenant self-hosted deployment genuinely needs.
 *   2. Our own infrastructure — reject anything resolving to the host:port of
 *      this app's own database, Evolution, Evolution's database, the Telegram
 *      bridge or the bridge's database, whatever its address class. This one is never disabled, and it is what still stops
 *      `postgres:5432` on a deployment that had to turn (1) off.
 *
 * The opt-out is deployment-wide and deliberately not a per-connection setting.
 * A checkbox on the connection form would let any user disable the guard for
 * themselves, which is the whole attack.
 */

const DENY_V4 = new BlockList()
DENY_V4.addSubnet('0.0.0.0', 8) // "this network"
DENY_V4.addSubnet('10.0.0.0', 8) // RFC1918
DENY_V4.addSubnet('100.64.0.0', 10) // CGNAT
DENY_V4.addSubnet('127.0.0.0', 8) // loopback
DENY_V4.addSubnet('169.254.0.0', 16) // link-local, incl. cloud metadata 169.254.169.254
DENY_V4.addSubnet('172.16.0.0', 12) // RFC1918, incl. the pinned compose subnet 172.31.250.0/24
DENY_V4.addSubnet('192.0.0.0', 24) // IETF protocol assignments
DENY_V4.addSubnet('192.168.0.0', 16) // RFC1918
DENY_V4.addSubnet('198.18.0.0', 15) // benchmarking
DENY_V4.addSubnet('224.0.0.0', 4) // multicast
DENY_V4.addSubnet('240.0.0.0', 4) // reserved

const DENY_V6 = new BlockList()
DENY_V6.addAddress('::', 'ipv6')
DENY_V6.addAddress('::1', 'ipv6')
DENY_V6.addSubnet('fc00::', 7, 'ipv6') // unique-local
DENY_V6.addSubnet('fe80::', 10, 'ipv6') // link-local
DENY_V6.addSubnet('ff00::', 8, 'ipv6') // multicast
DENY_V6.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64 — wraps a v4 address
DENY_V6.addSubnet('64:ff9b:1::', 48, 'ipv6') // local-use NAT64 — wraps a v4 address
// Every other way of carrying a v4 address in a v6 one. `canonicalAddress`
// already unwraps ::ffff:0:0/96 to its v4 address, so that entry is the
// backstop; the other two are not routed to v4 by Linux, and nothing public
// lives in either.
DENY_V6.addSubnet('::ffff:0:0', 96, 'ipv6') // IPv4-mapped
DENY_V6.addSubnet('::', 96, 'ipv6') // IPv4-compatible (deprecated), incl. :: and ::1
DENY_V6.addSubnet('::ffff:0:0:0', 96, 'ipv6') // IPv4-translated (SIIT)

/** Only the approved address is used by callers; the rest stayed unread. */
export interface ResolvedTarget {
  address: string
}

/**
 * The eight 16-bit groups of an IPv6 literal, or undefined when it is not one.
 * Handles `::` and a dotted v4 tail; a zone (`%eth0`) is dropped.
 */
function v6Groups(literal: string): number[] | undefined {
  let text = literal.split('%')[0]!.toLowerCase()
  if (isIP(text) !== 6) return undefined
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::') as [string, string | undefined]
  const parse = (part: string) => (part ? part.split(':').map(h => Number.parseInt(h, 16)) : [])
  const front = parse(head)
  const back = tail === undefined ? [] : parse(tail)
  const groups = tail === undefined ? front : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back]
  return groups.length === 8 ? groups : undefined
}

/**
 * One spelling per address, so the checks below see what the kernel dials.
 *
 * An IPv4-mapped address (`::ffff:0:0/96`) is the v4 address it carries — a
 * socket opened to `::ffff:7f00:1` connects to 127.0.0.1 — so it comes back as
 * that v4 address, whichever way it was written: `::ffff:127.0.0.1`,
 * `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`. Only the dotted form used to be
 * recognised, and the hex forms were checked as v6, where nothing denied them
 * (GHSA-rm8v-cvpx-c3g6). Any other v6 address comes back fully compressed and
 * lower-case, as `URL` writes it, so two spellings of one address compare
 * equal.
 */
function canonicalAddress(address: string, family: number): { address: string, family: 4 | 6 } {
  if (family !== 6 && isIP(address) !== 6) return { address, family: 4 }
  const groups = v6Groups(address)
  if (!groups) return { address, family: 6 }
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xFFFF) {
    const [hi, lo] = [groups[6]!, groups[7]!]
    return { address: `${hi >> 8}.${hi & 0xFF}.${lo >> 8}.${lo & 0xFF}`, family: 4 }
  }
  const compressed = new URL(`http://[${groups.map(g => g.toString(16)).join(':')}]`).hostname.slice(1, -1)
  // The zone stays on: a link-local address is dialled through it, and this
  // is the address callers pin.
  const zone = address.includes('%') ? address.slice(address.indexOf('%')) : ''
  return { address: compressed + zone, family: 6 }
}

/**
 * Every address a socket reaches this host by: 127.0.0.0/8, `::1`, and the
 * unspecified addresses, which Linux dials as loopback too.
 */
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8)
LOOPBACK.addSubnet('0.0.0.0', 8)
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addAddress('::', 'ipv6')

function isLoopback(target: { address: string, family: 4 | 6 }): boolean {
  return LOOPBACK.check(target.address.split('%')[0]!, target.family === 4 ? 'ipv4' : 'ipv6')
}

function refuse(label: string, detail: string): never {
  throw createError({ statusCode: 422, message: `${label}: ${detail}` })
}

/**
 * Resolve a host and refuse it if it points anywhere it should not.
 *
 * Returns the first approved address, which callers that *can* pin should dial
 * instead of the hostname — see `pg-pool.ts`.
 */
export async function assertPublicTarget(
  hostname: string,
  port: number,
  label: string,
): Promise<ResolvedTarget> {
  if (!hostname) refuse(label, 'no host')
  if (hostname.includes('/')) refuse(label, 'a unix socket path is not a host')
  if (hostname.includes(',')) refuse(label, 'multiple hosts are not supported')

  // Resolve *every* answer, not just the first. A resolver is free to return
  // several addresses and the socket layer is free to pick any of them, so one
  // private answer among four public ones is a bypass if only [0] is checked.
  let answers: Array<{ address: string, family: number }>
  if (isIP(hostname)) {
    answers = [{ address: hostname, family: isIP(hostname) }]
  }
  else {
    try {
      answers = await lookup(hostname, { all: true, verbatim: true })
    }
    catch (cause) {
      // A handled createError is invisible to Nitro's logger, and "it just says
      // 422" is not a diagnosis an operator can act on.
      console.error(`[net-guard] DNS lookup failed for ${hostname}`, cause)
      refuse(label, `${hostname} does not resolve`)
    }
  }

  if (answers.length === 0) refuse(label, `${hostname} does not resolve`)

  const resolved = answers.map(a => canonicalAddress(a.address, a.family))
  const allowPrivate = useRuntimeConfig().allowPrivateTargets === true

  if (!allowPrivate) {
    for (const { address, family } of resolved) {
      const blocked = family === 4 ? DENY_V4.check(address, 'ipv4') : DENY_V6.check(address, 'ipv6')
      if (blocked) {
        refuse(
          label,
          `${hostname} resolves to ${address}, a private or loopback address. `
          + 'This server only connects to publicly routable hosts. If this is a '
          + 'single-tenant, self-hosted deployment, set NUXT_ALLOW_PRIVATE_TARGETS=true.',
        )
      }
    }
  }

  await assertNotOwnInfrastructure(resolved, port, hostname, label)

  return { address: resolved[0]!.address }
}

/** Parse a URL and check where it points. Returns the approved address. */
export async function assertPublicUrl(rawUrl: string, label: string): Promise<ResolvedTarget> {
  let url: URL
  try {
    url = new URL(rawUrl)
  }
  catch {
    refuse(label, `${rawUrl} is not a valid URL`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    refuse(label, `${url.protocol} is not supported; use http or https`)
  }

  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  return assertPublicTarget(url.hostname, port, label)
}

// ── our own infrastructure ─────────────────────────────────────────────────

interface OwnTarget { address: string, family: 4 | 6, port: number, what: string }

let ownCache: { at: number, targets: OwnTarget[] } | undefined
const OWN_TTL_MS = 5 * 60_000

/**
 * Where this deployment's own backends live, as addresses rather than names.
 *
 * Derived from configuration rather than hardcoded to the compose service names,
 * so it survives a rename and also covers a deployment whose own Postgres has a
 * perfectly public hostname — the case the address-class check cannot see.
 *
 * Resolution failures are ignored rather than fatal: a backend that is down must
 * not make creating an unrelated connection impossible. That is a deliberate
 * softening of a security check, and it is safe only because the address-class
 * check above is the primary control; on a deployment that disabled *that*, a
 * DNS outage briefly widens this one.
 */
async function ownTargets(): Promise<OwnTarget[]> {
  const now = Date.now()
  if (ownCache && now - ownCache.at < OWN_TTL_MS) return ownCache.targets

  const config = useRuntimeConfig()
  const sources: Array<{ raw: string, what: string, defaultPort: number }> = []

  if (config.databaseUrl) sources.push({ raw: config.databaseUrl, what: 'this app\'s own database', defaultPort: 5432 })
  if (config.evolutionUrl) sources.push({ raw: config.evolutionUrl, what: 'this app\'s Evolution server', defaultPort: 80 })
  if (config.evolutionDatabaseUrl) sources.push({ raw: config.evolutionDatabaseUrl, what: 'Evolution\'s database', defaultPort: 5432 })
  if (config.telegramUrl) sources.push({ raw: config.telegramUrl, what: 'this app\'s Telegram bridge', defaultPort: 80 })
  if (config.telegramDatabaseUrl) sources.push({ raw: config.telegramDatabaseUrl, what: 'the Telegram bridge\'s database', defaultPort: 5432 })

  const targets: OwnTarget[] = []
  let complete = true

  for (const source of sources) {
    let url: URL
    try {
      url = new URL(source.raw)
    }
    catch {
      continue
    }
    const port = Number(url.port)
      || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : source.defaultPort)
    // `URL` keeps an IPv6 literal's brackets in `hostname`; with them it is
    // neither an IP nor a resolvable name, and the backend silently dropped
    // out of this list.
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    try {
      const answers = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await lookup(host, { all: true, verbatim: true })
      for (const a of answers) {
        targets.push({ ...canonicalAddress(a.address, a.family), port, what: source.what })
      }
    }
    catch (cause) {
      // A resolver hiccup must not be cached: doing so disabled the one check
      // that is never meant to be disabled, for a full TTL, on exactly the
      // deployments that turned the address-class check off. Successes only —
      // the same rule the contact directory follows.
      console.error(`[net-guard] could not resolve ${source.what} (${url.hostname}); own-infrastructure check is incomplete this request`, cause)
      complete = false
    }
  }

  if (complete) ownCache = { at: now, targets }
  return targets
}

/**
 * Both sides are canonical (`canonicalAddress`), so `::ffff:7f00:1` matches an
 * own 127.0.0.1. And a backend on loopback is reachable by *every* loopback
 * address on its port — 127.0.0.2 and `::1` reach a listener on 127.0.0.1 or on
 * `localhost` — so any loopback address on that port is the backend.
 */
async function assertNotOwnInfrastructure(
  resolved: Array<{ address: string, family: 4 | 6 }>,
  port: number,
  hostname: string,
  label: string,
): Promise<void> {
  const own = await ownTargets()
  if (own.length === 0) return

  for (const candidate of resolved) {
    const hit = own.find(t => t.port === port
      && (t.address === candidate.address || (isLoopback(t) && isLoopback(candidate))))
    if (hit) {
      refuse(
        label,
        `${hostname}:${port} is ${hit.what}. A connection may not point at this `
        + 'deployment\'s own backends — that would reach other users\' data.',
      )
    }
  }
}
