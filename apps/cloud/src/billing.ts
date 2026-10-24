import Stripe from 'stripe'
import type { StripeSettings } from './config.ts'
import type { Sql } from './db.ts'
import { HttpError, billingNotConfigured, describeError } from './http-error.ts'
import {
  INCLUDED_SEATS,
  TRIAL_DAYS,
  applyPlanEntitlements,
  billableSeats,
  memberCount,
  planOf,
  recordPlanChanges,
} from './plans.ts'

/**
 * Stripe: the only file that imports the SDK or talks to Stripe. Moved here
 * from the web app, which now forwards its billing routes to this service and
 * enforces limits from the columns this file keeps true.
 *
 * Two rules hold it up, unchanged by the move:
 *
 * - **The webhook payload is a hint; a live read is the fact.** Every event,
 *   and the hourly reconcile, ends in `syncOrg()`, which re-reads the customer's
 *   subscriptions from Stripe and writes what it finds. Duplicate and
 *   out-of-order deliveries cost a read each and converge on the same answer.
 * - **Links carry the configured app URL only**, never anything from a request.
 *
 * Seats follow membership: `syncSeats()` sets the seat price's quantity to the
 * members beyond the included five. It runs from the outbox consumer after a
 * join or removal, and from the reconcile.
 */

/** The billing columns of one organization, still on `app.organizations`. */
interface OrgBilling {
  id: string
  name: string
  stripe_customer_id?: string
  stripe_subscription_id?: string
  subscription_status?: string
  trial_ends_at?: string
  current_period_end?: string
  cancel_at_period_end: boolean
  trial_used: boolean
}

/** Subscriptions Stripe still considers live; an organization should hold at most one. */
const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'])

/** Order of preference when a customer holds more than one subscription. */
const STATUS_RANK = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'canceled', 'incomplete_expired']

export interface BillingSummary {
  plan: 'free' | 'pro'
  status: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  hasBillingAccount: boolean
  canStartTrial: boolean
  trialDays: number
  includedSeats: number
  billedSeats: number
}

export class Billing {
  readonly #sql: Sql
  readonly #settings?: StripeSettings
  readonly #appUrl: string
  readonly #stripe?: Stripe

  constructor(sql: Sql, settings: StripeSettings | undefined, appUrl: string) {
    this.#sql = sql
    this.#settings = settings
    this.#appUrl = appUrl
    this.#stripe = settings
      ? new Stripe(settings.secretKey, { maxNetworkRetries: 2, appInfo: { name: 'automata-cloud' } })
      : undefined
  }

  get configured(): boolean {
    return Boolean(this.#stripe)
  }

  #client(): { stripe: Stripe, settings: StripeSettings } {
    if (!this.#stripe || !this.#settings) throw billingNotConfigured()
    return { stripe: this.#stripe, settings: this.#settings }
  }

  async #org(orgId: string): Promise<OrgBilling> {
    const [org] = await this.#sql<OrgBilling[]>`
      SELECT id, name, stripe_customer_id, stripe_subscription_id, subscription_status,
             trial_ends_at, current_period_end, cancel_at_period_end, trial_used
      FROM app.organizations WHERE id = ${orgId}
    `
    if (!org) throw new HttpError(404, 'Not found.')
    return org
  }

  /** What the Billing page shows about the subscription. Usage and limits come from the web app. */
  async summary(orgId: string): Promise<BillingSummary> {
    const org = await this.#org(orgId)
    const plan = planOf(org.subscription_status)
    return {
      plan,
      status: org.subscription_status ?? null,
      trialEndsAt: org.trial_ends_at ?? null,
      currentPeriodEnd: org.current_period_end ?? null,
      cancelAtPeriodEnd: org.cancel_at_period_end,
      hasBillingAccount: Boolean(org.stripe_customer_id),
      canStartTrial: !org.trial_used,
      trialDays: TRIAL_DAYS,
      includedSeats: INCLUDED_SEATS,
      billedSeats: plan === 'pro' ? billableSeats(await memberCount(this.#sql, orgId)) : 0,
    }
  }

  /**
   * The organization's Stripe customer, created on first use. The idempotency
   * key makes two racing first calls get the same customer back from Stripe,
   * and the conditional UPDATE means only one of them writes it.
   */
  async #ensureCustomer(org: OrgBilling, adminEmail: string): Promise<string> {
    if (org.stripe_customer_id) return org.stripe_customer_id
    const { stripe } = this.#client()

    let customer: Stripe.Customer
    try {
      customer = await stripe.customers.create(
        { email: adminEmail, name: org.name, metadata: { org_id: org.id } },
        { idempotencyKey: `automata-customer-${org.id}` },
      )
    }
    catch (error) {
      stripeFailed('create customer', error)
    }

    const [written] = await this.#sql<{ stripe_customer_id: string }[]>`
      UPDATE app.organizations SET stripe_customer_id = ${customer.id}, updated = now()
      WHERE id = ${org.id} AND stripe_customer_id IS NULL
      RETURNING stripe_customer_id
    `
    if (written) return written.stripe_customer_id
    return (await this.#org(org.id)).stripe_customer_id ?? customer.id
  }

  /**
   * A Checkout session for Pro, answered as the URL to send the browser to.
   *
   * Whether the trial applies is decided from Stripe, not from `trial_used`: a
   * customer who has ever held a subscription has had theirs. An organization
   * already holding a live subscription is refused — a second Checkout would
   * bill it twice.
   */
  async checkout(orgId: string, adminEmail: string): Promise<string> {
    const { stripe, settings } = this.#client()
    const org = await this.#org(orgId)
    const customer = await this.#ensureCustomer(org, adminEmail)

    let existing: Stripe.Subscription[]
    try {
      existing = (await stripe.subscriptions.list({ customer, status: 'all', limit: 100 })).data
    }
    catch (error) {
      stripeFailed('list subscriptions', error)
    }

    if (existing.some(sub => LIVE_STATUSES.has(sub.status))) {
      throw new HttpError(409, 'This organization already has a subscription. Use Manage billing to change it.')
    }

    const seats = billableSeats(await memberCount(this.#sql, orgId))
    const trial = existing.length === 0 && !org.trial_used

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: orgId,
        line_items: [
          { price: settings.priceBase, quantity: 1 },
          ...(seats > 0 ? [{ price: settings.priceSeat, quantity: seats }] : []),
        ],
        // Card upfront even for the trial, so day 8 charges without asking.
        payment_method_collection: 'always',
        // A promotion code field on the Checkout page, for comps and promos.
        // Codes and their coupons are created in the Stripe dashboard.
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { org_id: orgId },
          ...(trial ? { trial_period_days: TRIAL_DAYS } : {}),
        },
        metadata: { org_id: orgId },
        success_url: `${this.#appUrl}/billing?checkout=success`,
        cancel_url: `${this.#appUrl}/billing`,
      })
      if (!session.url) throw new Error('Checkout session has no url')
      return session.url
    }
    catch (error) {
      stripeFailed('create checkout session', error)
    }
  }

  /** A Customer Portal session: card, invoices, cancel. */
  async portal(orgId: string): Promise<string> {
    const { stripe } = this.#client()
    const org = await this.#org(orgId)
    if (!org.stripe_customer_id) {
      throw new HttpError(409, 'There is no billing account yet. Start a plan first.')
    }
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: org.stripe_customer_id,
        return_url: `${this.#appUrl}/billing`,
      })
      return session.url
    }
    catch (error) {
      stripeFailed('create portal session', error)
    }
  }

  /**
   * Re-read an organization's subscription from Stripe, store what it says, and
   * bring its enforced limits into line — one transaction, so the limits never
   * disagree with the stored status.
   *
   * The one writer of `subscription_status`. Idempotent: any number of calls,
   * in any order, converge on Stripe's current answer. `trial_used` only ever
   * turns on — once a customer has held any subscription, the trial is spent.
   */
  async syncOrg(orgId: string): Promise<void> {
    const { stripe } = this.#client()
    const org = await this.#org(orgId)
    if (!org.stripe_customer_id) return

    let subs: Stripe.Subscription[]
    try {
      subs = (await stripe.subscriptions.list({ customer: org.stripe_customer_id, status: 'all', limit: 100 })).data
    }
    catch (error) {
      stripeFailed('list subscriptions', error)
    }

    const rank = (sub: Stripe.Subscription) => {
      const index = STATUS_RANK.indexOf(sub.status)
      return index === -1 ? STATUS_RANK.length : index
    }
    const current = [...subs].sort((a, b) => rank(a) - rank(b) || b.created - a.created)[0]
    // Since API version 2025-03-31 the billing period lives on each item.
    const periodEnd = current?.items.data.reduce((latest, item) => Math.max(latest, item.current_period_end ?? 0), 0)

    await this.#sql.begin(async (tx) => {
      await tx`
        UPDATE app.organizations SET
          stripe_subscription_id = ${current?.id ?? null},
          subscription_status    = ${current?.status ?? null},
          trial_ends_at          = ${isoFromUnix(current?.trial_end)},
          current_period_end     = ${isoFromUnix(periodEnd)},
          cancel_at_period_end   = ${Boolean(current?.cancel_at_period_end || current?.cancel_at)},
          trial_used             = trial_used OR ${subs.length > 0},
          updated                = now()
        WHERE id = ${orgId}
      `
      await recordPlanChanges(tx, await applyPlanEntitlements(tx, orgId), current?.status ?? null)
    })
  }

  /**
   * Bring the seat price's quantity in line with the member count. The seat
   * item is added when the first billed seat appears and removed when the last
   * one goes, so an invoice never carries a zero-quantity line. Only a Pro
   * organization with a subscription has anything to sync.
   */
  async syncSeats(orgId: string): Promise<void> {
    const { stripe, settings } = this.#client()
    const [org] = await this.#sql<Pick<OrgBilling, 'stripe_subscription_id' | 'subscription_status'>[]>`
      SELECT stripe_subscription_id, subscription_status FROM app.organizations WHERE id = ${orgId}
    `
    if (!org || planOf(org.subscription_status) !== 'pro' || !org.stripe_subscription_id) return

    const want = billableSeats(await memberCount(this.#sql, orgId))
    try {
      const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id)
      const item = subscription.items.data.find(i => i.price.id === settings.priceSeat)
      const have = item?.quantity ?? 0
      if (want !== have) {
        if (want === 0 && item) {
          await stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' })
        }
        else if (item) {
          await stripe.subscriptionItems.update(item.id, { quantity: want, proration_behavior: 'create_prorations' })
        }
        else {
          await stripe.subscriptionItems.create({
            subscription: subscription.id,
            price: settings.priceSeat,
            quantity: want,
            proration_behavior: 'create_prorations',
          })
        }
      }
    }
    catch (error) {
      stripeFailed('sync seats', error)
    }

    await this.#sql`UPDATE app.organizations SET seats_billed = ${want}, updated = now() WHERE id = ${orgId}`
  }

  /**
   * Cancel whatever an organization that no longer exists is still paying for.
   *
   * An organization is deleted when its only member accepts an invitation into
   * another one. Its row — and the customer id on it — is gone by the time the
   * `org.deleted` event arrives, so the customer is found by the `org_id`
   * metadata it was created with. Cancelled immediately: nobody can reach the
   * organization any more, so there is nothing left to bill for.
   */
  async cancelForDeletedOrg(orgId: string): Promise<number> {
    const { stripe } = this.#client()
    // Ids are uuids or PocketBase ids; anything else is refused rather than
    // spliced into a search query.
    if (!/^[A-Za-z0-9-]{1,64}$/.test(orgId)) return 0

    let cancelled = 0
    try {
      const customers = await stripe.customers.search({ query: `metadata['org_id']:'${orgId}'`, limit: 10 })
      for (const customer of customers.data) {
        const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 })
        for (const sub of subs.data) {
          if (!LIVE_STATUSES.has(sub.status)) continue
          await stripe.subscriptions.cancel(sub.id)
          cancelled++
        }
      }
    }
    catch (error) {
      stripeFailed('cancel for deleted organization', error)
    }
    if (cancelled) console.info(`[billing] cancelled ${cancelled} subscription(s) of deleted organization ${orgId}`)
    return cancelled
  }

  /** The organization a Stripe customer belongs to, or `undefined`. */
  async orgIdForCustomer(customerId: string): Promise<string | undefined> {
    const [row] = await this.#sql<{ id: string }[]>`
      SELECT id FROM app.organizations WHERE stripe_customer_id = ${customerId}
    `
    return row?.id
  }

  /** Verify and parse a webhook delivery. Throws on a bad signature. */
  constructEvent(payload: Buffer, signature: string): Stripe.Event {
    const { stripe, settings } = this.#client()
    return stripe.webhooks.constructEvent(payload, signature, settings.webhookSecret)
  }

  /** Every organization with a Stripe customer, for the reconcile. */
  async billedOrgIds(): Promise<string[]> {
    const rows = await this.#sql<{ id: string }[]>`
      SELECT id FROM app.organizations WHERE stripe_customer_id IS NOT NULL ORDER BY id
    `
    return rows.map(row => row.id)
  }
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

/**
 * Turn a Stripe failure into a 502 the operator can find in the log. Nothing
 * about the request is echoed; Stripe's own message is logged, not sent.
 */
function stripeFailed(what: string, error: unknown): never {
  if (error instanceof HttpError) throw error
  console.error(`[billing] Stripe call failed (${what}): ${describeError(error)}`)
  throw new HttpError(502, 'The payment provider could not be reached. Try again in a moment.')
}
