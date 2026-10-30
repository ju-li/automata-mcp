/**
 * The Billing page: the subscription, from the cloud service, joined to what
 * the organization holds and what it may hold, from the web app's own tables.
 *
 * The local half answers even when the cloud service cannot — limits and
 * usage are this app's facts — so the page still shows them during an outage
 * and says billing is unavailable instead of failing outright. Admin only;
 * 404 without the hosted offering.
 */
interface CloudSummary {
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

export default defineEventHandler(async (event) => {
  requireHosted()
  const actor = await requireOrgAdmin(event)

  const sql = await appDb()
  const [limits, usage, summary] = await Promise.all([
    loadOrgLimits(sql, actor.org.id),
    orgUsage(sql, actor.org.id),
    cloudFetch<CloudSummary>(`/orgs/${encodeURIComponent(actor.org.id)}/billing`).catch(() => undefined),
  ])

  return {
    ...summary,
    // Without the cloud service the plan is whatever the limits say.
    plan: summary?.plan ?? (hasLimits(limits) ? 'free' : 'pro'),
    billingUnavailable: !summary,
    usage,
    // What is enforced, read from the entitlement columns, so the page shows
    // exactly what the checks will apply.
    limits: hasLimits(limits)
      ? { connections: limits?.max_connections, tokens: limits?.max_tokens, members: limits?.max_members }
      : null,
    overLimit: overLimit(limits, usage),
  }
})
