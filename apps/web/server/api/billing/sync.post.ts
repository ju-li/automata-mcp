/**
 * Have the cloud service re-read the subscription from Stripe now. The Billing
 * page calls this when the browser returns from Checkout, so the plan does not
 * wait on the webhook. Admin only.
 */
export default defineEventHandler(async (event) => {
  requireHosted()
  const actor = await requireOrgAdmin(event)
  return await cloudFetch<{ ok: true }>(`/orgs/${encodeURIComponent(actor.org.id)}/sync`, { method: 'POST' })
})
