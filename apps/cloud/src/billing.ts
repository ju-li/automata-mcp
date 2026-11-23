import type postgres from 'postgres'
import Stripe from 'stripe'
import type { StripeSettings } from './config.ts'
import type { Db, Sql } from './db.ts'
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
      subs = (await stripe.subscriptions.list({
        customer: org.stripe_customer_id,
        status: 'all',
        limit: 100,
        expand: ['data.discounts'],
      })).data
    }
    catch (error) {
      stripeFailed('list subscriptions', error)
    }
    const rows = await this.#subscriptionRows(subs, orgId)

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
      await upsertSubscriptions(tx, rows)
    })
  }

  /**
   * What `cloud.stripe_subscriptions` stores for each subscription just read.
   * A discount's coupon arrives as an id unless Stripe expanded it; it is then
   * fetched (once per coupon per call), since the percent or amount off is
   * what tells a 100%-off comp from a paying customer.
   *
   * Best effort: a failed lookup stores the discount without its coupon's
   * terms, logged, and never fails the sync. These rows are reporting; the
   * sync around them is what writes the organization's plan, and a restricted
   * key without `coupon_read` once failed every discounted organization's
   * sync — a customer paying with a promotion code would have stayed on Free.
   */
  async #subscriptionRows(subs: Stripe.Subscription[], orgId: string): Promise<SubscriptionRow[]> {
    const { stripe, settings } = this.#client()
    const coupons = new Map<string, Stripe.Coupon | undefined>()
    const couponOf = async (discount: Stripe.Discount): Promise<Stripe.Coupon | undefined> => {
      const coupon = discount.source?.coupon
      if (!coupon) return undefined
      if (typeof coupon !== 'string') return coupon
      if (coupons.has(coupon)) return coupons.get(coupon)
      let found: Stripe.Coupon | undefined
      try {
        found = await stripe.coupons.retrieve(coupon)
      }
      catch (error) {
        console.warn(`[billing] could not read coupon ${coupon} for subscription reporting; stored without its terms: ${describeError(error)}`)
      }
      coupons.set(coupon, found)
      return found
    }

    const rows: SubscriptionRow[] = []
    for (const sub of subs) {
      const discounts = sub.discounts.filter((d): d is Stripe.Discount => typeof d !== 'string')
      if (sub.discounts.length > 1) {
        console.warn(`[billing] subscription ${sub.id} carries ${sub.discounts.length} discounts; cloud.stripe_subscriptions stores the first`)
      }
      const discount = discounts[0]
      const coupon = discount ? await couponOf(discount) : undefined
      rows.push(subscriptionRow(sub, orgId, settings, discount, coupon))
    }
    return rows
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

/** One entry of `items`: every item on the subscription, as Stripe holds it. */
interface StoredItem {
  price_id: string
  product_id: string
  unit_amount: number | null
  quantity: number
}

/** One row of `cloud.stripe_subscriptions`; see db.ts for the columns. */
interface SubscriptionRow {
  id: string
  customer_id: string
  organization_id: string
  status: string
  created: string
  start_date: string
  trial_start: string | null
  trial_end: string | null
  cancel_at: string | null
  canceled_at: string | null
  ended_at: string | null
  current_period_end: string | null
  currency: string
  interval: string
  interval_count: number
  base_price_id: string | null
  base_unit_amount: number | null
  seat_price_id: string | null
  seat_unit_amount: number | null
  seat_quantity: number
  period_amount: number
  items: StoredItem[]
  coupon_id: string | null
  percent_off: number | null
  amount_off: number | null
  discount_start: string | null
  discount_end: string | null
}

/**
 * Map a subscription to its stored row. The seat item is the one on the
 * configured seat price; the base is the configured base price, else the first
 * other item (a subscription made on an older base price still has one).
 * Stripe requires every item of a subscription to share one interval, so the
 * base item's is the subscription's. A price without `unit_amount` (tiered or
 * metered — none sold today) counts as 0.
 */
function subscriptionRow(
  sub: Stripe.Subscription,
  orgId: string,
  settings: StripeSettings,
  discount: Stripe.Discount | undefined,
  coupon: Stripe.Coupon | undefined,
): SubscriptionRow {
  const items = sub.items.data
  const seat = items.find(item => item.price.id === settings.priceSeat)
  const base = items.find(item => item.price.id === settings.priceBase) ?? items.find(item => item !== seat)
  const recurring = (base ?? items[0])?.price.recurring
  const periodEnd = items.reduce((latest, item) => Math.max(latest, item.current_period_end ?? 0), 0)
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id

  return {
    id: sub.id,
    customer_id: customer,
    organization_id: orgId,
    status: sub.status,
    created: isoFromUnix(sub.created)!,
    start_date: isoFromUnix(sub.start_date) ?? isoFromUnix(sub.created)!,
    trial_start: isoFromUnix(sub.trial_start),
    trial_end: isoFromUnix(sub.trial_end),
    cancel_at: isoFromUnix(sub.cancel_at),
    canceled_at: isoFromUnix(sub.canceled_at),
    ended_at: isoFromUnix(sub.ended_at),
    current_period_end: isoFromUnix(periodEnd),
    currency: sub.currency,
    interval: recurring?.interval ?? 'month',
    interval_count: recurring?.interval_count ?? 1,
    base_price_id: base?.price.id ?? null,
    base_unit_amount: base?.price.unit_amount ?? null,
    seat_price_id: seat?.price.id ?? null,
    seat_unit_amount: seat?.price.unit_amount ?? null,
    seat_quantity: seat?.quantity ?? 0,
    period_amount: items.reduce((sum, item) => sum + (item.price.unit_amount ?? 0) * (item.quantity ?? 1), 0),
    items: items.map(item => ({
      price_id: item.price.id,
      product_id: typeof item.price.product === 'string' ? item.price.product : item.price.product.id,
      unit_amount: item.price.unit_amount,
      quantity: item.quantity ?? 1,
    })),
    coupon_id: coupon?.id ?? null,
    percent_off: coupon?.percent_off ?? null,
    amount_off: coupon?.amount_off ?? null,
    discount_start: discount ? isoFromUnix(discount.start) : null,
    discount_end: discount ? isoFromUnix(discount.end) : null,
  }
}

/**
 * Upsert what `syncOrg` just read, in its transaction. Keyed on the Stripe
 * id, so any number of reads converge; rows are never deleted.
 */
async function upsertSubscriptions(tx: Db, rows: SubscriptionRow[]): Promise<void> {
  for (const row of rows) {
    await tx`
      INSERT INTO cloud.stripe_subscriptions (
        id, customer_id, organization_id, status, created, start_date, trial_start, trial_end,
        cancel_at, canceled_at, ended_at, current_period_end, currency, "interval", interval_count,
        base_price_id, base_unit_amount, seat_price_id, seat_unit_amount, seat_quantity,
        period_amount, items, coupon_id, percent_off, amount_off, discount_start, discount_end
      ) VALUES (
        ${row.id}, ${row.customer_id}, ${row.organization_id}, ${row.status}, ${row.created},
        ${row.start_date}, ${row.trial_start}, ${row.trial_end}, ${row.cancel_at}, ${row.canceled_at},
        ${row.ended_at}, ${row.current_period_end}, ${row.currency}, ${row.interval}, ${row.interval_count},
        ${row.base_price_id}, ${row.base_unit_amount}, ${row.seat_price_id}, ${row.seat_unit_amount},
        ${row.seat_quantity}, ${row.period_amount}, ${tx.json(row.items as unknown as postgres.JSONValue)}, ${row.coupon_id},
        ${row.percent_off}, ${row.amount_off}, ${row.discount_start}, ${row.discount_end}
      )
      ON CONFLICT (id) DO UPDATE SET
        customer_id        = EXCLUDED.customer_id,
        organization_id    = EXCLUDED.organization_id,
        status             = EXCLUDED.status,
        created            = EXCLUDED.created,
        start_date         = EXCLUDED.start_date,
        trial_start        = EXCLUDED.trial_start,
        trial_end          = EXCLUDED.trial_end,
        cancel_at          = EXCLUDED.cancel_at,
        canceled_at        = EXCLUDED.canceled_at,
        ended_at           = EXCLUDED.ended_at,
        current_period_end = EXCLUDED.current_period_end,
        currency           = EXCLUDED.currency,
        "interval"         = EXCLUDED."interval",
        interval_count     = EXCLUDED.interval_count,
        base_price_id      = EXCLUDED.base_price_id,
        base_unit_amount   = EXCLUDED.base_unit_amount,
        seat_price_id      = EXCLUDED.seat_price_id,
        seat_unit_amount   = EXCLUDED.seat_unit_amount,
        seat_quantity      = EXCLUDED.seat_quantity,
        period_amount      = EXCLUDED.period_amount,
        items              = EXCLUDED.items,
        coupon_id          = EXCLUDED.coupon_id,
        percent_off        = EXCLUDED.percent_off,
        amount_off         = EXCLUDED.amount_off,
        discount_start     = EXCLUDED.discount_start,
        discount_end       = EXCLUDED.discount_end,
        updated_at         = now()
    `
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
