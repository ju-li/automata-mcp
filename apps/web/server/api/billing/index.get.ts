/**
 * The organization's plan, what it holds, and what the plan allows — the
 * Billing page. Admin only; 404 on a deployment without billing.
 */
export default defineEventHandler(async (event) => {
  requireBillingEnabled()
  const actor = await requireOrgAdmin(event)

  const sql = await appDb()
  const [org, usage] = await Promise.all([loadOrgBilling(sql, actor.org.id), orgUsage(sql, actor.org.id)])
  const plan = effectivePlan(org)

  return {
    plan,
    status: org?.subscription_status ?? null,
    trialEndsAt: org?.trial_ends_at ?? null,
    currentPeriodEnd: org?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(org?.cancel_at_period_end),
    hasBillingAccount: Boolean(org?.stripe_customer_id),
    canStartTrial: !org?.trial_used,
    trialDays: TRIAL_DAYS,
    usage,
    limits: plan === 'free' ? FREE_LIMITS : null,
    overLimit: overLimit(plan, usage),
    includedSeats: INCLUDED_SEATS,
    billedSeats: plan === 'pro' ? billableSeats(usage.members) : 0,
  }
})
