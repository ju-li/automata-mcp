/**
 * Stripe's Customer Portal: change card, see invoices, cancel. Admin only.
 */
export default defineEventHandler(async (event) => {
  requireHosted()
  const actor = await requireOrgAdmin(event)
  return await cloudFetch<{ url: string }>(`/orgs/${encodeURIComponent(actor.org.id)}/portal`, { method: 'POST' })
})
