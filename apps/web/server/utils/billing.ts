import type { AppOrganizationBilling, Db } from './app-db'

/**
 * Plans, and the one place that decides which one an organization is on.
 *
 * This exists for the hosted offering only. `NUXT_BILLING` is `off` by default
 * and every self-hosted deployment leaves it there: no plan picker, no billing
 * page, no limits, every billing route a 404, and every organization behaves
 * exactly as it did before plans existed (`effectivePlan` answers `unlimited`).
 *
 * With `NUXT_BILLING=stripe` there are two plans:
 *
 *   free   1 connection, 1 connector token, 1 user
 *   pro    7-day trial (card upfront), then a flat monthly price with five
 *          users included and a per-seat price beyond; everything unlimited
 *
 * This file decides *which plan* an organization is on. It does not enforce
 * anything: `applyPlanEntitlements()` turns the plan into the `max_*` columns,
 * and `entitlements.ts` enforces those without knowing plans exist. That split
 * is what lets selling plans move to a separate service later while the checks
 * stay inside the app's own transactions.
 *
 * **An organization is born on Free and becomes Pro only when Stripe says so.**
 * `subscription_status` is written by `syncOrgFromStripe()` (stripe.ts) from a
 * live read of Stripe, never from a webhook payload, and nothing else writes it.
 * A signup that picked Pro and abandoned checkout is therefore a working Free
 * account, never an organization stuck halfway.
 *
 * **Lapsing deletes nothing.** An organization whose trial ended unpaid, whose
 * card failed for good, or which cancelled, reads as Free again. Everything it
 * built stays; its Free limits come back into force (see entitlements.ts) until
 * it resubscribes, which brings every other token back unchanged.
 */

export type BillingMode = 'off' | 'stripe'

export type Plan = 'unlimited' | 'free' | 'pro'

/** What Free allows. Pro has no limits; it bills seats instead. */
export const FREE_LIMITS = { connections: 1, tokens: 1, members: 1 } as const

/** Members included in Pro's base price; each one beyond is a billed seat. */
export const INCLUDED_SEATS = 5

/** The length of Pro's trial, in days. */
export const TRIAL_DAYS = 7

/**
 * Stripe statuses that mean Pro.
 *
 * `past_due` is Stripe retrying a failed renewal under the account's dunning
 * settings, and counts as Pro until Stripe gives up and moves the subscription
 * to `canceled` or `unpaid`: dropping someone to Free on the first declined
 * charge would break their connectors over a card that renews tomorrow.
 * `incomplete`, `incomplete_expired`, `unpaid`, `paused` and `canceled` are Free.
 */
const PRO_STATUSES = new Set(['trialing', 'active', 'past_due'])

let warnedMode = false

/**
 * `off` unless `NUXT_BILLING` says otherwise. An unknown value is read as
 * `stripe`: the only deployment that sets this at all is the hosted one, and a
 * typo there must not quietly hand every organization unlimited use.
 */
export function billingMode(): BillingMode {
  const value = String(useRuntimeConfig().billing ?? '').trim().toLowerCase()
  if (!value || value === 'off') return 'off'
  if (value !== 'stripe' && !warnedMode) {
    warnedMode = true
    console.error(`[billing] NUXT_BILLING=${value} is not "off" or "stripe"; treating it as stripe.`)
  }
  return 'stripe'
}

export function billingEnabled(): boolean {
  return billingMode() !== 'off'
}

/** Which plan an organization is on, from its stored Stripe status alone. */
export function effectivePlan(org: Pick<AppOrganizationBilling, 'subscription_status'> | undefined): Plan {
  if (!billingEnabled()) return 'unlimited'
  return org?.subscription_status && PRO_STATUSES.has(org.subscription_status) ? 'pro' : 'free'
}

/**
 * 404 for a billing route on a deployment without billing, so a self-hosted
 * install exposes nothing that even suggests plans exist.
 */
export function requireBillingEnabled(): void {
  if (!billingEnabled()) throw createError({ statusCode: 404, statusMessage: 'Not found' })
}

/** Billed seats on Pro: every member beyond the included five. */
export function billableSeats(members: number): number {
  return Math.max(0, members - INCLUDED_SEATS)
}

export async function loadOrgBilling(db: Db, orgId: string): Promise<AppOrganizationBilling | undefined> {
  const [org] = await db<AppOrganizationBilling[]>`
    SELECT id, name, stripe_customer_id, stripe_subscription_id, subscription_status,
           trial_ends_at, current_period_end, cancel_at_period_end, trial_used, seats_billed
    FROM app.organizations WHERE id = ${orgId}
  `
  return org
}

/**
 * The limits a new organization starts with: Free's, with billing on, and
 * none at all without it. Written by `createOrganizationFor` in the signup
 * transaction, so an organization never exists unlimited on a deployment that
 * sells plans.
 */
export function newOrganizationLimits(): Record<'max_connections' | 'max_tokens' | 'max_members', number | null> & { plan_label: string | null } {
  if (!billingEnabled()) return { max_connections: null, max_tokens: null, max_members: null, plan_label: null }
  return {
    max_connections: FREE_LIMITS.connections,
    max_tokens: FREE_LIMITS.tokens,
    max_members: FREE_LIMITS.members,
    plan_label: 'Free',
  }
}

/**
 * Turn the stored Stripe status into entitlements: Free's limits, or none for
 * Pro. One statement, so the rule is written once whether it runs for one
 * organization after a sync or for all of them at boot.
 *
 * This is the bridge between selling plans and enforcing limits.
 * `entitlements.ts` reads only the `max_*` columns and never a Stripe status;
 * when the cloud service takes over selling plans it writes the same columns
 * and this function goes with the rest of the Stripe code.
 *
 * Answers the organizations whose plan label changed, so the caller can
 * record `plan.changed`.
 */
export async function applyPlanEntitlements(db: Db, orgId?: string): Promise<{ id: string, from?: string, to: string }[]> {
  if (!billingEnabled()) return []
  const pro = [...PRO_STATUSES]
  const rows = await db<{ id: string, from?: string, to: string }[]>`
    WITH next AS (
      SELECT id, plan_label AS previous,
             COALESCE(subscription_status = ANY(${pro}), false) AS is_pro,
             CASE
               WHEN subscription_status = 'trialing' THEN 'Pro (trial)'
               WHEN subscription_status = ANY(${pro}) THEN 'Pro'
               ELSE 'Free'
             END AS label
      FROM app.organizations
      WHERE ${orgId ?? null}::text IS NULL OR id = ${orgId ?? null}
    )
    UPDATE app.organizations o SET
      max_connections = CASE WHEN next.is_pro THEN NULL ELSE ${FREE_LIMITS.connections}::int END,
      max_tokens      = CASE WHEN next.is_pro THEN NULL ELSE ${FREE_LIMITS.tokens}::int END,
      max_members     = CASE WHEN next.is_pro THEN NULL ELSE ${FREE_LIMITS.members}::int END,
      plan_label      = next.label
    FROM next
    WHERE o.id = next.id
    RETURNING o.id, next.previous AS "from", next.label AS "to"
  `
  return rows.filter(row => row.from !== row.to)
}
