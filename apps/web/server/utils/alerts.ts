import type { AppInstance } from './pocketbase'
import { assertNever } from '#shared/connection'
import type { ConnectionState, InstanceKind } from '#shared/connection'

/**
 * Telling the people who use a connection that it died.
 *
 * Two things feed this, and they are not redundant:
 *
 *   the webhook  `connection.update` from Evolution or the Telegram bridge,
 *                which arrives within seconds of a logout, a ban, a replaced
 *                or a revoked session.
 *   the sweep    an hourly pass over every WhatsApp and Telegram connection.
 *
 * The sweep is not a backstop for a flaky webhook — it is the only thing that
 * sees the failure that matters most. In 2.3.7 a close Evolution intends to
 * retry emits **no** `connection.update` at all (`connectionUpdate` in
 * whatsapp.baileys.service.ts reconnects and returns), so a socket that dies and
 * never comes back is silent on the webhook forever. That is the same failure
 * `sessionLost` exists for, and only a live read finds it.
 *
 * Both paths end up in `evaluateConnectionHealth`, and neither one reads a state
 * out of a webhook payload. The global webhook sends no headers, so a delivery
 * may be unauthenticated and anyone can post one; treating its `state` as fact
 * would let a stranger mail a user that their connection is down. The payload
 * says *look at this connection*, and `readConnectionHealth()` says what is true.
 */

/**
 * One connection's health, in the terms alerting needs, whatever its kind.
 *
 * Built from a live read — `getInstanceStatus()` for WhatsApp, the bridge's
 * `/state` for Telegram — and never from a stored column.
 */
type ConnectionHealth = {
  kind: 'whatsapp' | 'telegram'
  state: ConnectionState
  /** Linked, and the transport dropped. Reconnect is enough. */
  sessionLost: boolean
  /**
   * The connection has been linked at some point, so a bad state is an outage
   * rather than a connection nobody has finished setting up.
   */
  paired: boolean
  /**
   * The source said, definitively, that nothing is linked. Only then is an open
   * outage closed without a mail — see `evaluateConnectionHealth`.
   */
  knownUnlinked: boolean
  /** Telegram ended the session. Only linking again by QR recovers it. */
  revoked: boolean
  /** Telegram only: the bridge could not be asked at all. */
  unreachable: boolean
  /** Telegram only: another bridge process holds the session. */
  heldElsewhere: boolean
}

/**
 * Read one connection's live health. Throws only where the underlying read
 * does; both reads report an unreachable backend as `unknown` instead.
 *
 * **What "paired" means differs by kind, and both answers are deliberate.**
 *
 * WhatsApp: `ownerJid`. A fresh instance and a logout both leave Evolution in
 * `close`, and `ownerJid` is the only thing that tells them apart. It is also
 * absent when Evolution cannot be reached, so an Evolution outage is invisible
 * here — which is today's behaviour, and nothing can say more without a stored
 * "was linked" fact.
 *
 * Telegram: the bridge keeps the account's identity (`me`) on the session row
 * through a dropped connection and through a revocation, and clears it only on
 * logout — so its presence is "was linked and not deliberately unlinked". A
 * bridge that cannot be reached answers `unknown` with no identity, and that is
 * counted as paired: a connection this server cannot check is one its users
 * cannot use, and the deployment's bridge going down is precisely what an
 * operator needs to hear about. The cost is that a connection nobody has linked
 * yet also mails once during a bridge outage — with wording that is true for it.
 */
async function readConnectionHealth(instance: AppInstance, kind: 'whatsapp' | 'telegram'): Promise<ConnectionHealth> {
  switch (kind) {
    case 'whatsapp': {
      const status = await getInstanceStatus(instance)
      return {
        kind,
        state: status.state,
        sessionLost: Boolean(status.sessionLost),
        paired: Boolean(status.ownerJid),
        knownUnlinked: false,
        revoked: false,
        unreachable: false,
        heldElsewhere: false,
      }
    }
    case 'telegram': {
      const status = await getTelegramStatus(instance)
      const linked = Boolean(status.telegramUserId)
      const unreachable = status.state === 'unknown' && !linked
      return {
        kind,
        state: status.state,
        sessionLost: Boolean(status.sessionLost),
        paired: linked || unreachable,
        knownUnlinked: !linked && !unreachable,
        revoked: Boolean(status.revoked),
        unreachable,
        heldElsewhere: Boolean(status.heldElsewhere),
      }
    }
    default:
      return assertNever(kind)
  }
}

/** The kinds alerting covers. Postgres has no liveness signal short of a timed connection. */
function alertableKind(instance: AppInstance): 'whatsapp' | 'telegram' | undefined {
  const kind: InstanceKind = instanceKind(instance)
  switch (kind) {
    case 'whatsapp':
    case 'telegram':
      return kind
    case 'postgres':
      return undefined
    default:
      return assertNever(kind)
  }
}

/**
 * How long a connection must be unhealthy before anyone is told.
 *
 * Only `connecting` and `unknown` serve it out — a live `close` is Evolution
 * having given up, so it mails at once. The grace exists for the states that
 * routinely resolve themselves: a reconnect in progress, or one failed status
 * read against a server that is merely restarting.
 */
const GRACE_MS = 10 * 60 * 1000

/**
 * Decide, for one connection, whether anything needs to be said.
 *
 * Idempotent, and safe to call as often as you like — the two date fields on the
 * row are what make it so. `down_since` empty means healthy; `alerted_at` set
 * means the current outage has already been reported, which is what stops the
 * hourly sweep from mailing hourly.
 *
 * A connection that has never been paired is skipped entirely. A fresh instance
 * sits in `close` until somebody scans its QR code, and that is not an outage —
 * see `readConnectionHealth` for what tells the two apart per kind.
 *
 * Mail failures deliberately do not advance the state: `alerted_at` is written
 * only once a message actually went out, so a broken SMTP configuration means a
 * late alert rather than a lost one.
 *
 * Concurrent calls for one connection share one evaluation. The webhook and the
 * sweep can land together — registering a Telegram webhook to a new URL makes
 * the bridge deliver the current state straight away — and two evaluations that
 * both read `alerted_at` empty would both mail.
 */
export function evaluateConnectionHealth(instance: AppInstance): Promise<void> {
  const running = inFlight.get(instance.id)
  if (running) return running

  const evaluation = evaluate(instance).finally(() => inFlight.delete(instance.id))
  inFlight.set(instance.id, evaluation)
  return evaluation
}

/** Per worker, like the webhook cooldown. The sweep and the webhook run in the same one. */
const inFlight = new Map<string, Promise<void>>()

async function evaluate(instance: AppInstance): Promise<void> {
  const kind = alertableKind(instance)
  if (!kind) return

  const health = await readConnectionHealth(instance, kind)
  const pb = await pocketbaseAdmin()

  if (!health.paired) {
    // Unlinked on purpose — a Telegram logout clears the account — while an
    // outage was open. Nothing is broken any more and nothing is working
    // either, so neither mail is true; close the outage quietly, or linking
    // again later would send a "connected again" for an outage long over.
    if (health.knownUnlinked && (instance.down_since || instance.alerted_at)) {
      await pb.collection('instances').update(instance.id, { down_since: '', alerted_at: '' })
    }
    return
  }

  const healthy = health.state === 'open' && !health.sessionLost

  if (healthy) {
    if (!instance.down_since && !instance.alerted_at) return

    if (instance.alerted_at) {
      // Nobody was told it broke, so there is nothing to say about it working.
      const sent = await notifyWatchers(instance, () => recoveryMail(instance, health))
      if (!sent) return
    }

    await pb.collection('instances').update(instance.id, { down_since: '', alerted_at: '' })
    return
  }

  if (!instance.down_since) {
    await pb.collection('instances').update(instance.id, { down_since: new Date().toISOString() })
    // Fall through to the grace check below rather than returning: a live
    // `close` is already definitive and should not wait an hour for the next
    // sweep to say so.
  }

  if (instance.alerted_at) return

  const downSince = parsePocketBaseDate(instance.down_since) ?? Date.now()
  const definitive = health.state === 'close'
  if (!definitive && Date.now() - downSince < GRACE_MS) return

  const sent = await notifyWatchers(instance, canManage => outageMail(instance, health, canManage))
  if (sent) await pb.collection('instances').update(instance.id, { alerted_at: new Date().toISOString() })
}

/**
 * The hourly pass. Registered as the `alerts:sweep` scheduled task.
 *
 * Sequential, and every connection is wrapped on its own: one unreachable
 * Evolution server or Telegram bridge must not decide that the connections after
 * it in the list go unchecked. The failure is logged per connection — a handled error is invisible
 * to Nitro, and "the sweep quietly did half its work" is the exact shape of
 * problem that goes unnoticed for a week.
 *
 * A connection whose status read fails reads as `unknown`, which is unhealthy.
 * That is the honest answer: a connection this server cannot reach is one its
 * users cannot use either. It costs one grace period before anything is sent.
 */
export async function sweepConnectionAlerts(): Promise<{ checked: number, failed: number }> {
  const pb = await pocketbaseAdmin()

  // `kind` is backfilled and required (1787460000_polymorphic_instances.js), so
  // filtering on it here cannot miss a pre-`kind` row the way reading the field
  // directly could. Postgres connections have no liveness signal short of
  // opening a connection on a timer, and are out of scope.
  const instances = await pb.collection('instances').getFullList<AppInstance>({
    filter: pb.filter('kind = {:whatsapp} || kind = {:telegram}', { whatsapp: 'whatsapp', telegram: 'telegram' }),
    sort: 'created',
  })

  let failed = 0

  for (const instance of instances) {
    // Re-asserted rather than assumed: this heals a connection created before
    // alerting existed, one whose server or bridge was rebuilt, and one whose
    // registration failed at provision time (where it is deliberately
    // non-fatal). Cheap at one call per connection per hour.
    await registerWebhookFor(instance).catch(() => {})

    try {
      await evaluateConnectionHealth(instance)
    }
    catch (error) {
      failed++
      console.error(`[alerts] could not evaluate connection ${instance.id} (${instance.name}):`, error)
    }
  }

  return { checked: instances.length, failed }
}

function registerWebhookFor(instance: AppInstance): Promise<void> {
  switch (alertableKind(instance)) {
    case 'whatsapp': return registerConnectionWebhook(instance)
    case 'telegram': return registerTelegramWebhook(instance)
    default: return Promise.resolve()
  }
}

interface AlertMail {
  subject: string
  text: string
}

interface AlertRecipient {
  email: string
  /** An admin of the owning organization. Decides which fix the mail names. */
  canManage: boolean
}

/**
 * PocketBase serialises a date as `2026-09-12 10:00:00.000Z` — a space where
 * ISO 8601 wants a `T`. V8's fallback parser accepts it, but not by contract,
 * so it is normalised here rather than relied upon. An unparseable value answers
 * undefined and the caller treats the outage as starting now, which costs one
 * grace period and never an alert.
 */
function parsePocketBaseDate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function connectionUrl(instance: AppInstance): string | undefined {
  const appUrl = useRuntimeConfig().public.appUrl
  if (!appUrl) return undefined
  return `${appUrl.replace(/\/+$/, '')}/instances/${instance.id}`
}

function connectionLabel(instance: AppInstance, kind: ConnectionHealth['kind']): string {
  return instance.label?.trim() || (kind === 'telegram' ? 'your Telegram connection' : 'your WhatsApp connection')
}

/**
 * What the reader is asked to do differs on two axes, and both get it wrong in a
 * way that costs something real.
 *
 * **Which failure it is.** `sessionLost` means the phone is still linked and
 * Reconnect is enough; a connection that is not linked any more needs a QR scan.
 * The dashboard already draws that distinction, and getting it backwards sends
 * someone to re-pair a number that did not need it.
 *
 * **Who is reading.** Reconnecting and re-pairing are management, so a member
 * has neither button — `InstanceWhatsapp.vue` does not even enter pairing mode
 * for them. Telling them to press one is the failure the panel is careful to
 * avoid, reproduced in their inbox where nobody can see that the button is
 * missing. They are told what the state is and who can fix it instead.
 */
function outageMail(instance: AppInstance, health: ConnectionHealth, canManage: boolean): AlertMail {
  const label = connectionLabel(instance, health.kind)
  const url = connectionUrl(instance)

  const cause = health.kind === 'telegram' ? telegramOutageCause(health, canManage) : whatsappOutageCause(health, canManage)

  return {
    subject: `${label} is disconnected`,
    text: [
      `${label} has stopped working, so anything connected to it — including MCP `
      + 'tools — cannot read or send messages right now.',
      '',
      cause,
      ...(url ? ['', url] : []),
      '',
      'You will get one more email when it is working again.',
    ].join('\n'),
  }
}

function whatsappOutageCause(health: ConnectionHealth, canManage: boolean): string {
  return health.sessionLost
    ? canManage
      ? 'The session dropped. The phone is still linked, so reconnecting should be '
        + 'enough — open the connection and press Reconnect. No QR scan needed.'
      : 'The session dropped. The phone is still linked, so an admin can bring it '
        + 'back with Reconnect — no QR scan needed.'
    : canManage
      ? 'The account is no longer linked. Open the connection and scan the QR code '
        + 'again to pair it.'
      : 'The account is no longer linked. An admin has to scan the QR code again '
        + 'to pair it.'
}

/**
 * Telegram has four distinct failures, and each has a different fix — or a
 * different person to fix it. A revocation needs a new QR link and says where it
 * came from, so nobody hunts for a bug; a dropped connection needs Reconnect and
 * explicitly no scan; and the two bridge problems are the operator's, so an admin
 * is pointed at the service rather than at a button that cannot help.
 */
function telegramOutageCause(health: ConnectionHealth, canManage: boolean): string {
  if (health.unreachable) {
    return canManage
      ? 'The Telegram bridge this connection runs on could not be reached. The account '
        + 'is not unlinked and nothing needs scanning — check that the bridge service is '
        + 'running and reachable from this app.'
      : 'The Telegram bridge this connection runs on could not be reached. The account '
        + 'is not unlinked and nothing needs scanning; an admin has been told as well.'
  }
  if (health.heldElsewhere) {
    return canManage
      ? 'Another copy of the Telegram bridge is holding this session, which usually '
        + 'means two copies are running at once (for example an overlapping deploy). '
        + 'Run the bridge as a single instance; nothing needs scanning.'
      : 'The Telegram bridge is misconfigured for this connection. Nothing needs '
        + 'scanning; an admin has been told as well.'
  }
  if (health.revoked) {
    return canManage
      ? 'Telegram ended the session — it was terminated under Telegram → Settings → '
        + 'Devices, or by Telegram itself. Open the connection and link it again by QR '
        + 'code. Chats synced so far are kept.'
      : 'Telegram ended the session — it was terminated under Telegram → Settings → '
        + 'Devices, or by Telegram itself. An admin has to link it again by QR code.'
  }
  if (health.sessionLost) {
    return canManage
      ? 'The connection to Telegram dropped. The account is still linked, so '
        + 'reconnecting should be enough — open the connection and press Reconnect. '
        + 'No QR scan needed.'
      : 'The connection to Telegram dropped. The account is still linked, so an admin '
        + 'can bring it back with Reconnect — no QR scan needed.'
  }
  return canManage
    ? 'The account is no longer linked. Open the connection and link it again by QR code.'
    : 'The account is no longer linked. An admin has to link it again by QR code.'
}

function recoveryMail(instance: AppInstance, health: ConnectionHealth): AlertMail {
  const label = connectionLabel(instance, health.kind)
  const url = connectionUrl(instance)

  return {
    subject: `${label} is connected again`,
    text: [
      `${label} is back. Reading and sending work again; nothing else is needed.`,
      ...(url ? ['', url] : []),
    ].join('\n'),
  }
}

/**
 * Everyone who can reach this connection, and so everyone for whom it breaking
 * is their problem: every admin of the owning organization, plus the members it
 * is assigned to.
 *
 * That set is not invented here — it is `authorizesInstance()` evaluated over
 * the roster, the same predicate the session and MCP surfaces decide access
 * with. Mailing a different set would mean a second definition of "reaches this
 * connection" that drifts from the one that grants it.
 *
 * `listOrgMembers` already carries each member's email, so this is two reads
 * whatever the size of the organization.
 */
async function recipientsFor(instance: AppInstance): Promise<AlertRecipient[]> {
  // The schema forbids it, but fail closed rather than mail an organization
  // resolved from an empty string.
  if (!instance.org) return []

  const [members, assignees] = await Promise.all([
    listOrgMembers(instance.org),
    listInstanceAssignees(instance.id),
  ])

  const assigned = new Set(assignees)

  return members
    .filter(member => authorizesInstance(
      { role: member.role, orgId: instance.org },
      instance.org,
      assigned.has(member.userId),
    ))
    .filter(member => Boolean(member.email))
    .map(member => ({ email: member.email, canManage: member.role === 'admin' }))
}

/**
 * Resolve the recipients and send. Answers whether the mail reached anyone.
 *
 * Recipients are resolved here rather than passed in because both callers hold
 * the instance and not a person, and because a connection whose organization has
 * emptied out should be skipped quietly rather than throw inside a sweep.
 *
 * One message each rather than one message with everyone in `to`: the recipients
 * are colleagues, not a mailing list, and putting a company's roster in a header
 * is a disclosure nobody asked for. "Reached anyone" is the bar for writing
 * `alerted_at` — one failed address must not queue a repeat to the others on
 * every sweep.
 */
async function notifyWatchers(
  instance: AppInstance,
  build: (canManage: boolean) => AlertMail,
): Promise<boolean> {
  let recipients: AlertRecipient[]

  try {
    recipients = await recipientsFor(instance)
  }
  catch (error) {
    console.error(`[alerts] could not resolve who to notify about connection ${instance.id}:`, error)
    return false
  }

  if (!recipients.length) {
    // Reachable: an organization whose only admin was removed, or a connection
    // assigned to nobody in an organization with no admin left. Worth a line —
    // the alert is computed and then has nowhere to go.
    console.error(`[alerts] connection ${instance.id} has nobody to notify; not sending "${build(true).subject}".`)
    return false
  }

  const results = await Promise.all(recipients.map((recipient) => {
    const mail = build(recipient.canManage)
    return sendAppEmail({ to: recipient.email, subject: mail.subject, text: mail.text })
  }))

  return results.some(Boolean)
}
