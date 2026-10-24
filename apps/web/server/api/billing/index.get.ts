/**
 * The organization's plan, what it holds, and what the plan allows — the
 * Billing page. Admin only; 404 on a deployment without billing.
 */
export default defineEventHandler(async (event) => {
  requireBillingEnabled()
  const actor = await requireOrgAdmin(event)

  const sql = await appDb()
  const [org, limits, usage] = await Promise.all([
    loadOrgBilling(sql, actor.org.id),
    loadOrgLimits(sql, actor.org.id),
    orgUsage(sql, actor.org.id),
  ])
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
    // What is enforced, read from the entitlement columns rather than derived
    // from the plan, so the page shows exactly what the checks will apply.
    limits: hasLimits(limits)
      ? { connections: limits?.max_connections, tokens: limits?.max_tokens, members: limits?.max_members }
      : null,
    overLimit: overLimit(limits, usage),
    includedSeats: INCLUDED_SEATS,
    billedSeats: plan === 'pro' ? billableSeats(usage.members) : 0,
  }
})
