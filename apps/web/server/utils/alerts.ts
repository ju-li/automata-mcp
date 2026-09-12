import type { AppInstance, AppUser } from './pocketbase'
import type { InstanceStatus } from './instances'

/**
 * Telling a connection's owner that it died.
 *
 * Two things feed this, and they are not redundant:
 *
 *   the webhook  `connection.update` from Evolution, which arrives within
 *                seconds of a logout, a ban or a replaced session.
 *   the sweep    an hourly pass over every WhatsApp connection.
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
 * says *look at this connection*, and `getInstanceStatus()` says what is true.
 */

/**
 * How long a connection must be unhealthy before its owner is told.
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
 * `ownerJid` is the only field that distinguishes the two, because a logout and
 * a never-paired account leave the state identical.
 *
 * Mail failures deliberately do not advance the state: `alerted_at` is written
 * only once a message actually went out, so a broken SMTP configuration means a
 * late alert rather than a lost one.
 */
export async function evaluateConnectionHealth(instance: AppInstance): Promise<void> {
  const status = await getInstanceStatus(instance)

  if (!status.ownerJid) return

  const pb = await pocketbaseAdmin()
  const healthy = status.state === 'open' && !status.sessionLost

  if (healthy) {
    if (!instance.down_since && !instance.alerted_at) return

    if (instance.alerted_at) {
      // Nobody was told it broke, so there is nothing to say about it working.
      const sent = await notifyOwner(instance, recoveryMail(instance, status))
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
  const definitive = status.state === 'close'
  if (!definitive && Date.now() - downSince < GRACE_MS) return

  const sent = await notifyOwner(instance, outageMail(instance, status))
  if (sent) await pb.collection('instances').update(instance.id, { alerted_at: new Date().toISOString() })
}

/**
 * The hourly pass. Registered as the `alerts:sweep` scheduled task.
 *
 * Sequential, and every connection is wrapped on its own: one unreachable
 * Evolution server must not decide that the connections after it in the list go
 * unchecked. The failure is logged per connection — a handled error is invisible
 * to Nitro, and "the sweep quietly did half its work" is the exact shape of
 * problem that goes unnoticed for a week.
 *
 * A connection whose status read fails reads as `unknown`, which is unhealthy.
 * That is the honest answer: a connection this server cannot reach is one its
 * owner cannot use either. It costs one grace period before anything is sent.
 */
export async function sweepConnectionAlerts(): Promise<{ checked: number, failed: number }> {
  const pb = await pocketbaseAdmin()

  // `kind` is backfilled and required (1787460000_polymorphic_instances.js), so
  // filtering on it here cannot miss a pre-`kind` row the way reading the field
  // directly could. Postgres connections have no liveness signal short of
  // opening a connection on a timer, and are out of scope.
  const instances = await pb.collection('instances').getFullList<AppInstance>({
    filter: pb.filter('kind = {:kind}', { kind: 'whatsapp' }),
    sort: 'created',
  })

  let failed = 0

  for (const instance of instances) {
    // Re-asserted rather than assumed: this heals a connection created before
    // alerting existed, one whose Evolution server was rebuilt, and one whose
    // registration failed at provision time (where it is deliberately
    // non-fatal). Cheap at one call per connection per hour.
    await registerConnectionWebhook(instance).catch(() => {})

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

interface AlertMail {
  subject: string
  text: string
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

function connectionLabel(instance: AppInstance): string {
  return instance.label?.trim() || 'your WhatsApp connection'
}

/**
 * What the owner is asked to do differs by which failure this is, and getting it
 * backwards wastes a real phone: `sessionLost` means the phone is still linked
 * and Reconnect is enough, while a connection that is simply not linked any more
 * needs a QR scan. The dashboard already draws that distinction; the mail must
 * make the same one or it sends people to scan a code they do not need to.
 */
function outageMail(instance: AppInstance, status: InstanceStatus): AlertMail {
  const label = connectionLabel(instance)
  const url = connectionUrl(instance)

  const cause = status.sessionLost
    ? 'The session dropped. Your phone is still linked, so reconnecting should be '
      + 'enough — open the connection and press Reconnect. No QR scan needed.'
    : 'The account is no longer linked. Open the connection and scan the QR code '
      + 'again to pair it.'

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

function recoveryMail(instance: AppInstance, _status: InstanceStatus): AlertMail {
  const label = connectionLabel(instance)
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
 * Resolve the owner and send. Answers whether the mail went out.
 *
 * The owner is read here rather than passed in because both callers hold the
 * instance and not the user, and because a connection whose owner has been
 * deleted should be skipped quietly rather than throwing inside a sweep.
 */
async function notifyOwner(instance: AppInstance, mail: AlertMail): Promise<boolean> {
  try {
    const pb = await pocketbaseAdmin()
    const owner = await pb.collection('users').getOne<AppUser>(instance.user)
    if (!owner?.email) {
      console.error(`[alerts] connection ${instance.id} has no owner email; not sending "${mail.subject}".`)
      return false
    }
    return await sendAppEmail({ to: owner.email, subject: mail.subject, text: mail.text })
  }
  catch (error) {
    console.error(`[alerts] could not resolve the owner of connection ${instance.id}:`, error)
    return false
  }
}
