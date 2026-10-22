/**
 * Inbound webhook from Stripe.
 *
 * Same single job as the Evolution and Telegram webhooks — notice that
 * something may have changed and go and read what is true — under one rule:
 * **the payload is a hint, never a fact.** Nothing on the event is written;
 * the customer it names is resolved to an organization and `syncOrgFromStripe`
 * re-reads that customer's subscriptions from Stripe. Duplicate and out-of-order
 * deliveries, which Stripe promises neither to avoid, therefore cost a read
 * each and converge on the same answer.
 *
 * Unlike those two, Stripe signs its deliveries, so a bad signature is a 400
 * (logged — handled errors are invisible to Nitro), and Stripe retries on any
 * non-2xx, so a sync that fails answers 500 to be delivered again.
 *
 * 404 on a deployment without billing, like every billing route.
 */
const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
])

export default defineEventHandler(async (event) => {
  requireBillingEnabled()

  const signature = getRequestHeader(event, 'stripe-signature')
  const payload = await readRawBody(event, false)
  if (!signature || !payload) {
    console.warn('[billing] Stripe webhook without a signature or body refused')
    throw createError({ statusCode: 400, statusMessage: 'Missing signature' })
  }

  let stripeEvent
  try {
    stripeEvent = constructStripeEvent(Buffer.from(payload), signature)
  }
  catch (error) {
    if (error && typeof error === 'object' && (error as { statusCode?: number }).statusCode === 503) throw error
    console.warn('[billing] Stripe webhook with a bad signature refused:', (error as Error)?.message)
    throw createError({ statusCode: 400, statusMessage: 'Invalid signature' })
  }

  if (!HANDLED.has(stripeEvent.type)) return { received: true }

  const object = stripeEvent.data.object as { customer?: string | { id: string } | null }
  const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id
  if (!customerId) return { received: true }

  const orgId = await orgIdForCustomer(customerId)
  if (!orgId) {
    // Another deployment's customer on a shared Stripe account, or an org
    // deleted since. Nothing to retry.
    console.warn(`[billing] Stripe ${stripeEvent.type} for unknown customer ${customerId} ignored`)
    return { received: true }
  }

  try {
    await syncOrgFromStripe(orgId)
    await syncSeats(orgId)
  }
  catch (error) {
    console.error(`[billing] sync after ${stripeEvent.type} for organization ${orgId} failed:`, error)
    throw createError({ statusCode: 500, statusMessage: 'Sync failed' })
  }

  return { received: true }
})
