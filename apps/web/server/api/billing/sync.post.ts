/**
 * Re-read the subscription from Stripe now. The Billing page calls this when
 * the browser returns from Checkout, so the plan does not wait on the webhook
 * — which may be seconds behind, or lost and left to the hourly reconcile.
 * Admin only.
 */
export default defineEventHandler(async (event) => {
  requireBillingEnabled()
  const actor = await requireOrgAdmin(event)
  await syncOrgFromStripe(actor.org.id)
  await syncSeats(actor.org.id)
  return { ok: true }
})
