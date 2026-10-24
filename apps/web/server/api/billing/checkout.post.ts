/**
 * Start Pro: the cloud service creates a Stripe Checkout session and this
 * answers its URL. Nothing changes here — the organization's limits lift when
 * Stripe confirms the subscription to the cloud service. Admin only; the
 * address is the acting admin's, for the Stripe customer.
 */
export default defineEventHandler(async (event) => {
  requireHosted()
  const actor = await requireOrgAdmin(event)
  return await cloudFetch<{ url: string }>(`/orgs/${encodeURIComponent(actor.org.id)}/checkout`, {
    method: 'POST',
    body: { email: actor.user.email },
  })
})
