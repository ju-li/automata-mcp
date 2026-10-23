import Stripe from 'stripe'
import type { AppOrganizationBilling, AppUser } from './app-db'

/**
 * Stripe: the only file that imports the SDK or talks to Stripe.
 *
 * `billing.ts` decides what a plan allows; this file keeps the organization's
 * Stripe columns true. Two rules hold it up:
 *
 * - **The webhook payload is a hint; a live read is the fact.** Every event,
 *   and the hourly reconcile, ends in `syncOrgFromStripe()`, which re-reads the
 *   customer's subscriptions from Stripe and writes what it finds. Stripe
 *   delivers events out of order and more than once; a sync that never trusts
 *   the payload is idempotent and indifferent to both, the same reason the
 *   Evolution webhook re-reads the live connection state.
 * - **Links carry `NUXT_PUBLIC_APP_URL` only**, never the request `Host`, which
 *   is the requester's choice — the same rule as verification links.
 *
 * Seats follow membership. `syncSeats()` runs after every join and removal and
 * sets the seat price's quantity to the members beyond the included five; the
 * Customer Portal must not offer quantity changes (docs/billing.md).
 */

let client: Stripe | undefined
let clientKey = ''
let warnedConfig = false

interface StripeSettings {
  secretKey: string
  webhookSecret: string
  priceBase: string
  priceSeat: string
}

function settings(): StripeSettings {
  const config = useRuntimeConfig()
  return {
    secretKey: String(config.stripeSecretKey ?? '').trim(),
    webhookSecret: String(config.stripeWebhookSecret ?? '').trim(),
    priceBase: String(config.stripePriceBase ?? '').trim(),
    priceSeat: String(config.stripePriceSeat ?? '').trim(),
  }
}

/** The settings that are missing, by env var name. Empty when Stripe is usable. */
export function missingStripeSettings(): string[] {
  const s = settings()
  return [
    !s.secretKey && 'NUXT_STRIPE_SECRET_KEY',
    !s.webhookSecret && 'NUXT_STRIPE_WEBHOOK_SECRET',
    !s.priceBase && 'NUXT_STRIPE_PRICE_BASE',
    !s.priceSeat && 'NUXT_STRIPE_PRICE_SEAT',
  ].filter((name): name is string => Boolean(name))
}

/**
 * The client, or a 503 that names what is missing. Limits are enforced with or
 * without Stripe configured — a deployment that cannot take payment must not
 * fall open — so this only gates the routes that need Stripe itself.
 */
function stripeClient(): Stripe {
  const missing = missingStripeSettings()
  if (missing.length) {
    if (!warnedConfig) {
      warnedConfig = true
      console.error(`[billing] Stripe is not configured: ${missing.join(', ')} unset.`)
    }
    throw createError({ statusCode: 503, statusMessage: 'Billing is not available right now.' })
  }
  const { secretKey } = settings()
  if (!client || clientKey !== secretKey) {
    client = new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: 'automata-mcp' } })
    clientKey = secretKey
  }
  return client
}

/** Where Checkout and the Portal send the browser back to. 501 when unset. */
function appUrl(): string {
  const url = String(useRuntimeConfig().public.appUrl ?? '').trim().replace(/\/+$/, '')
  if (!url) {
    console.error('[billing] NUXT_PUBLIC_APP_URL is unset, so Stripe has nowhere to send the browser back to.')
    throw createError({ statusCode: 501, statusMessage: 'Billing needs NUXT_PUBLIC_APP_URL to be set.' })
  }
  return url
}

/**
 * Turn a Stripe failure into a 502 the operator can find in the log. Handled
 * errors are invisible to Nitro, so the cause is logged here.
 */
function stripeFailed(what: string, error: unknown): never {
  if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 503) {
    throw error
  }
  console.error(`[billing] Stripe call failed (${what}):`, error)
  throw createError({ statusCode: 502, statusMessage: 'The payment provider could not be reached. Try again in a moment.' })
}

async function requireOrgBilling(orgId: string): Promise<AppOrganizationBilling> {
  const sql = await appDb()
  const org = await loadOrgBilling(sql, orgId)
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return org
}

/**
 * The organization's Stripe customer, created on first use.
 *
 * The idempotency key makes two racing first calls get the same customer back
 * from Stripe, and the conditional UPDATE means only one of them writes it.
 */
async function ensureCustomer(org: AppOrganizationBilling, admin: AppUser): Promise<string> {
  if (org.stripe_customer_id) return org.stripe_customer_id

  const stripe = stripeClient()
  let customer: Stripe.Customer
  try {
    customer = await stripe.customers.create(
      { email: admin.email, name: org.name, metadata: { org_id: org.id } },
      { idempotencyKey: `automata-customer-${org.id}` },
    )
  }
  catch (error) {
    stripeFailed('create customer', error)
  }

  const sql = await appDb()
  const [written] = await sql<{ stripe_customer_id: string }[]>`
    UPDATE app.organizations SET stripe_customer_id = ${customer.id}, updated = now()
    WHERE id = ${org.id} AND stripe_customer_id IS NULL
    RETURNING stripe_customer_id
  `
  if (written) return written.stripe_customer_id
  const again = await requireOrgBilling(org.id)
  return again.stripe_customer_id ?? customer.id
}

/** Subscriptions Stripe still considers live, one org should hold at most one of. */
const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'])

/**
 * A Checkout session for Pro, answered as the URL to send the browser to.
 *
 * Whether the trial applies is decided from Stripe, not from `trial_used`: a
 * customer who has ever held a subscription has had theirs. An organization
 * already holding a live subscription is sent to the Portal instead — a second
 * Checkout would bill it twice.
 */
export async function createCheckoutSession(orgId: string, admin: AppUser): Promise<string> {
  const org = await requireOrgBilling(orgId)
  const base = appUrl()
  const stripe = stripeClient()
  const { priceBase, priceSeat } = settings()
  const customer = await ensureCustomer(org, admin)

  let existing: Stripe.Subscription[]
  try {
    existing = (await stripe.subscriptions.list({ customer, status: 'all', limit: 100 })).data
  }
  catch (error) {
    stripeFailed('list subscriptions', error)
  }

  if (existing.some(sub => LIVE_STATUSES.has(sub.status))) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This organization already has a subscription. Use Manage billing to change it.',
    })
  }

  const sql = await appDb()
  const { members } = await orgUsage(sql, orgId)
  const seats = billableSeats(members)
  const trial = existing.length === 0 && !org.trial_used

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: orgId,
      line_items: [
        { price: priceBase, quantity: 1 },
        ...(seats > 0 ? [{ price: priceSeat, quantity: seats }] : []),
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
      success_url: `${base}/billing?checkout=success`,
      cancel_url: `${base}/billing`,
    })
    if (!session.url) throw new Error('Checkout session has no url')
    return session.url
  }
  catch (error) {
    stripeFailed('create checkout session', error)
  }
}

/** A Customer Portal session: card, invoices, cancel. */
export async function createPortalSession(orgId: string): Promise<string> {
  const org = await requireOrgBilling(orgId)
  if (!org.stripe_customer_id) {
    throw createError({ statusCode: 409, statusMessage: 'There is no billing account yet. Start a plan first.' })
  }
  const base = appUrl()
  const stripe = stripeClient()
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${base}/billing`,
    })
    return session.url
  }
  catch (error) {
    stripeFailed('create portal session', error)
  }
}

/** Order of preference when a customer holds more than one subscription. */
const STATUS_RANK = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'canceled', 'incomplete_expired']

function pickSubscription(subs: Stripe.Subscription[]): Stripe.Subscription | undefined {
  const rank = (sub: Stripe.Subscription) => {
    const index = STATUS_RANK.indexOf(sub.status)
    return index === -1 ? STATUS_RANK.length : index
  }
  return [...subs].sort((a, b) => rank(a) - rank(b) || b.created - a.created)[0]
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

/**
 * Re-read an organization's subscription from Stripe and store what it says.
 *
 * The one writer of `subscription_status`. Idempotent: any number of calls, in
 * any order, converge on Stripe's current answer. `trial_used` only ever turns
 * on — once a customer has held any subscription, the trial is spent.
 */
export async function syncOrgFromStripe(orgId: string): Promise<void> {
  const org = await requireOrgBilling(orgId)
  if (!org.stripe_customer_id) return

  const stripe = stripeClient()
  let subs: Stripe.Subscription[]
  try {
    subs = (await stripe.subscriptions.list({ customer: org.stripe_customer_id, status: 'all', limit: 100 })).data
  }
  catch (error) {
    stripeFailed('list subscriptions', error)
  }

  const current = pickSubscription(subs)
  // Since API version 2025-03-31 the billing period lives on each item.
  const periodEnd = current?.items.data.reduce((latest, item) => Math.max(latest, item.current_period_end ?? 0), 0)

  const sql = await appDb()
  await sql`
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
}

/** The organization a Stripe customer belongs to, or `undefined`. */
export async function orgIdForCustomer(customerId: string): Promise<string | undefined> {
  const sql = await appDb()
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM app.organizations WHERE stripe_customer_id = ${customerId}
  `
  return row?.id
}

/**
 * Bring the seat price's quantity in line with the member count.
 *
 * Members beyond the included five are billed seats, prorated. The seat item
 * is added when the first one appears and removed when the last one goes, so
 * an invoice never carries a zero-quantity line. Only a Pro organization with
 * a subscription has anything to sync.
 */
export async function syncSeats(orgId: string): Promise<void> {
  if (!billingEnabled()) return
  const org = await requireOrgBilling(orgId)
  if (effectivePlan(org) !== 'pro' || !org.stripe_subscription_id) return

  const stripe = stripeClient()
  const { priceSeat } = settings()
  const sql = await appDb()
  const { members } = await orgUsage(sql, orgId)
  const want = billableSeats(members)

  try {
    const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id)
    const item = subscription.items.data.find(i => i.price.id === priceSeat)
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
          price: priceSeat,
          quantity: want,
          proration_behavior: 'create_prorations',
        })
      }
    }
  }
  catch (error) {
    stripeFailed('sync seats', error)
  }

  await sql`UPDATE app.organizations SET seats_billed = ${want}, updated = now() WHERE id = ${orgId}`
}

/**
 * `syncSeats` after a membership change has committed. Never throws: the
 * change already happened, and a seat count that lags is fixed by the hourly
 * reconcile — failing the join or removal over it would be worse.
 */
export function syncSeatsLater(orgId: string | undefined): void {
  if (!orgId || !billingEnabled()) return
  syncSeats(orgId).catch((error) => {
    console.error(`[billing] seat sync for organization ${orgId} failed; the reconcile task will retry:`, error)
  })
}

/** Verify and parse a webhook delivery. Throws on a bad signature. */
export function constructStripeEvent(payload: Buffer, signature: string): Stripe.Event {
  const stripe = stripeClient()
  return stripe.webhooks.constructEvent(payload, signature, settings().webhookSecret)
}

/** Every organization with a Stripe customer, for the reconcile task. */
export async function listBilledOrgIds(): Promise<string[]> {
  const sql = await appDb()
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM app.organizations WHERE stripe_customer_id IS NOT NULL ORDER BY id
  `
  return rows.map(row => row.id)
}
