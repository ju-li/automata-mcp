/**
 * Stripe's Customer Portal: change card, see invoices, cancel. Admin only.
 */
export default defineEventHandler(async (event) => {
  requireBillingEnabled()
  const actor = await requireOrgAdmin(event)
  return { url: await createPortalSession(actor.org.id) }
})
