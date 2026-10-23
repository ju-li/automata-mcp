/**
 * Start Pro: a Stripe Checkout session, answered as the URL to send the
 * browser to. The trial applies when this organization has never held a
 * subscription. Nothing changes here — the organization becomes Pro when
 * Stripe's webhook says the subscription exists. Admin only.
 */
export default defineEventHandler(async (event) => {
  requireBillingEnabled()
  const actor = await requireOrgAdmin(event)
  return { url: await createCheckoutSession(actor.org.id, actor.user) }
})
