import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Crm } from './crm.ts'
import { BrevoError } from './crm.ts'
import type { Sql } from './db.ts'
import { HttpError, describeError } from './http-error.ts'

/**
 * Update mail for self-hosters: breaking changes and security advisories, and
 * nothing else. A self-hosted install's onboarding offers it; the install's
 * server posts the address here (`POST /self-host/updates`, public — a
 * self-hosted install holds no key of ours). Stored in
 * `cloud.self_host_subscribers`, then added to the Brevo list
 * `BREVO_SELF_HOST_LIST` through crm.ts — directly, or, with
 * `BREVO_SELF_HOST_DOI_TEMPLATE`, by double opt-in: Brevo mails a confirmation
 * link and adds the address only once it is clicked, then sends the browser to
 * `GET /self-host/confirmed` (self-host-confirmed.ts).
 *
 * Rules that hold it up:
 *
 * - **Public, so throttled.** Per caller address and in total, in memory — a
 *   speed bump, like the web app's invite-mail throttle. One replica's view.
 * - **The answer never says whether the address was already here.**
 * - **Storing is the promise; the list is a copy.** A failed Brevo call leaves
 *   the row unsynced and `syncPending` retries it, so an address taken is never
 *   lost to an outage.
 * - **Never logged:** the address or the caller's IP.
 * - **Double opt-in sends real mail, so at most one confirmation per address
 *   a day** (`doi_sent_at`, claimed by conditional UPDATE before the call, so
 *   racing submits and replicas agree). Without it the public route would mail
 *   any inbox from our domain on demand. A claim is handed back when Brevo
 *   answered with a refusal (nothing sent); kept when it did not answer at all,
 *   since it may have sent — that row is retried a day later. Resubmitting
 *   after a day sends a fresh link: the way back for someone who lost the first.
 */

const PER_CALLER_PER_HOUR = 5
const TOTAL_PER_HOUR = 300
const HOUR_MS = 60 * 60_000
/** Rows synced per pass. */
const SYNC_BATCH = 50
/** Shortest gap between two confirmation emails to one address. */
const DOI_GAP = '24 hours'

const body = z.object({
  email: z.string().trim().email().max(320),
  // The install's version, from its root package.json. Free text from a public
  // caller, so shape-checked and short.
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
})

export class SelfHostUpdates {
  private readonly callers = new Map<string, { count: number, resetAt: number }>()
  private total = { count: 0, resetAt: 0 }

  private readonly sql: Sql
  private readonly crm: Crm
  private readonly listId: number | undefined
  private readonly doi: { templateId: number, redirectUrl: string } | undefined

  constructor(sql: Sql, crm: Crm, listId: number | undefined, doi?: { templateId: number, redirectUrl: string }) {
    this.sql = sql
    this.crm = crm
    this.listId = listId
    this.doi = doi
  }

  /**
   * Whether stored addresses reach a Brevo list, and how. Reported on /health.
   * `confirming` = double opt-in.
   */
  get status(): 'stored-only' | 'syncing' | 'confirming' {
    if (!this.crm.configured || this.listId === undefined) return 'stored-only'
    return this.doi ? 'confirming' : 'syncing'
  }

  /**
   * `POST /self-host/updates`. Throws `HttpError` for the caller. Answers
   * whether the address must confirm by email — a property of this service's
   * settings, never of the address, so it says nothing about who is listed.
   */
  async subscribe(input: unknown, req: IncomingMessage): Promise<{ confirm: boolean }> {
    const parsed = body.safeParse(input)
    if (!parsed.success) throw new HttpError(400, 'Enter a valid email address.')
    this.claim(callerOf(req))

    const email = parsed.data.email.toLowerCase()
    const [row] = await this.sql<{ synced_at?: string, refused_at?: string }[]>`
      INSERT INTO cloud.self_host_subscribers (email, version)
      VALUES (${email}, ${parsed.data.version ?? null})
      ON CONFLICT (email) DO UPDATE SET version = COALESCE(EXCLUDED.version, cloud.self_host_subscribers.version), updated = now()
      RETURNING synced_at, refused_at
    `
    const confirm = this.status === 'confirming'
    if (row?.refused_at) return { confirm }
    // Added directly: once is enough. Double opt-in: resubmitting is how a lost
    // link is replaced, bounded by the daily claim in `sync`.
    if (row?.synced_at && !confirm) return { confirm }
    // Best effort now; syncPending is the retry. Not awaited past a failure.
    await this.sync(email).catch(error => console.warn(`[self-host] list sync deferred: ${describeError(error)}`))
    return { confirm }
  }

  /** Put every stored, unsynced address on the list (or ask it to confirm). Run on a timer. */
  async syncPending(): Promise<void> {
    if (this.status === 'stored-only') return
    const rows = await this.sql<{ email: string }[]>`
      SELECT email FROM cloud.self_host_subscribers
      WHERE synced_at IS NULL AND refused_at IS NULL
        AND (doi_sent_at IS NULL OR doi_sent_at < now() - ${DOI_GAP}::interval)
      ORDER BY created LIMIT ${SYNC_BATCH}
    `
    let synced = 0
    for (const { email } of rows) {
      try {
        await this.sync(email)
        synced++
      }
      catch (error) {
        // Brevo down, or the key refused: stop the pass, the next one retries.
        if (!(error instanceof BrevoError) || error.kind !== 'permanent') throw error
        if (this.doi) {
          // A refusal here can be the address or our template (wrong id, not a
          // double opt-in template); the two can't be told apart, and marking
          // every address refused over a settings mistake would lose them. The
          // claim stays, so it is tried again in a day.
          console.warn(`[self-host] Brevo refused a confirmation email: ${error.status}${error.code ? ` (${error.code})` : ''} — retried in a day; if every one fails, check BREVO_SELF_HOST_DOI_TEMPLATE`)
          continue
        }
        // An address Brevo calls invalid stays stored and unsynced; logged by
        // status alone, as crm.ts logs contact failures.
        console.warn(`[self-host] Brevo refused a subscriber: ${error.status}${error.code ? ` (${error.code})` : ''}`)
        await this.sql`UPDATE cloud.self_host_subscribers SET refused_at = now() WHERE email = ${email}`
      }
    }
    if (synced) {
      console.info(this.doi
        ? `[self-host] asked ${synced} subscriber(s) to confirm by email`
        : `[self-host] added ${synced} subscriber(s) to the Brevo list`)
    }
  }

  private async sync(email: string): Promise<void> {
    if (this.status === 'stored-only') return
    if (!this.doi) {
      await this.crm.addToList(email, this.listId!)
      await this.sql`UPDATE cloud.self_host_subscribers SET synced_at = now() WHERE email = ${email}`
      return
    }

    // Claim the day's confirmation email first; no row = one went out within
    // the day (or the address was refused), so nothing is sent.
    const [claim] = await this.sql<{ prev?: string }[]>`
      UPDATE cloud.self_host_subscribers s SET doi_sent_at = now()
      FROM (SELECT email, doi_sent_at AS prev FROM cloud.self_host_subscribers WHERE email = ${email} FOR UPDATE) p
      WHERE s.email = p.email AND s.refused_at IS NULL
        AND (p.prev IS NULL OR p.prev < now() - ${DOI_GAP}::interval)
      RETURNING p.prev
    `
    if (!claim) return
    try {
      await this.crm.requestDoubleOptIn(email, this.listId!, this.doi.templateId, this.doi.redirectUrl)
    }
    catch (error) {
      // Brevo down or the key refused: nothing was sent, hand the claim back for
      // the next pass. No answer at all: it may have sent, so the claim stands
      // for the day. A permanent refusal keeps it too (see syncPending).
      if (error instanceof BrevoError && error.status !== 0 && error.kind !== 'permanent') {
        await this.sql`UPDATE cloud.self_host_subscribers SET doi_sent_at = ${claim.prev ?? null} WHERE email = ${email}`
      }
      throw error
    }
    await this.sql`UPDATE cloud.self_host_subscribers SET synced_at = now() WHERE email = ${email}`
  }

  private claim(caller: string): void {
    const now = Date.now()
    if (now >= this.total.resetAt) this.total = { count: 0, resetAt: now + HOUR_MS }
    const mine = this.callers.get(caller)
    const current = mine && now < mine.resetAt ? mine : { count: 0, resetAt: now + HOUR_MS }
    if (current.count >= PER_CALLER_PER_HOUR || this.total.count >= TOTAL_PER_HOUR) {
      throw new HttpError(429, 'Too many signups right now. Try again later.')
    }
    current.count++
    this.total.count++
    this.callers.set(caller, current)
    if (this.callers.size > 10_000) {
      for (const [key, value] of this.callers) if (now >= value.resetAt) this.callers.delete(key)
    }
  }
}

/**
 * Who is calling, for the throttle only. Behind Railway's proxy the socket is
 * the proxy, which appends the real address as the last `X-Forwarded-For`
 * entry; anything before it is the caller's own claim.
 */
function callerOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map(part => part.trim()).filter(Boolean).at(-1)
  if (last && isIP(last)) return last
  return req.socket.remoteAddress ?? 'unknown'
}
