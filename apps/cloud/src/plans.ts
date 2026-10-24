import type { Db } from './db.ts'

/**
 * The plans, and the one place their rules live.
 *
 *   free   1 connection, 1 connector token, 1 user
 *   pro    7-day trial (card upfront), then a flat monthly price with five
 *          users included and a per-seat price beyond; everything unlimited
 *
 * The web app enforces limits but knows no plan: it reads three numbers per
 * organization (`max_connections`, `max_tokens`, `max_members`, NULL =
 * unlimited) and the defaults a new organization is born with. This file is
 * what writes both, from the Stripe status `syncOrgFromStripe` stores.
 */

export type PlanName = 'free' | 'pro'

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
 */
export const PRO_STATUSES = ['trialing', 'active', 'past_due'] as const

export function planOf(status: string | null | undefined): PlanName {
  return status && (PRO_STATUSES as readonly string[]).includes(status) ? 'pro' : 'free'
}

/** Billed seats on Pro: every member beyond the included five. */
export function billableSeats(members: number): number {
  return Math.max(0, members - INCLUDED_SEATS)
}

/**
 * The limits a new organization is born with: Free's. The web app reads this
 * row inside the signup transaction, so an organization never exists
 * unlimited on the hosted deployment — and it refuses signups while the row is
 * missing rather than create one unlimited. Written at every boot, so
 * changing Free's numbers here is a deploy.
 */
export async function writeEntitlementDefaults(db: Db): Promise<void> {
  await db`
    INSERT INTO app.entitlement_defaults (id, max_connections, max_tokens, max_members, plan_label)
    VALUES ('new_organization', ${FREE_LIMITS.connections}, ${FREE_LIMITS.tokens}, ${FREE_LIMITS.members}, 'Free')
    ON CONFLICT (id) DO UPDATE SET
      max_connections = EXCLUDED.max_connections,
      max_tokens      = EXCLUDED.max_tokens,
      max_members     = EXCLUDED.max_members,
      plan_label      = EXCLUDED.plan_label,
      updated         = now()
  `
}

export interface PlanChange {
  id: string
  from?: string
  to: string
}

/**
 * Turn each organization's stored Stripe status into entitlements: Free's
 * limits, or none for Pro. One statement, so the rule is written once whether
 * it runs for one organization after a sync or for all of them at boot.
 *
 * Answers the organizations whose plan label changed, for `plan.changed`.
 */
export async function applyPlanEntitlements(db: Db, orgId?: string): Promise<PlanChange[]> {
  const pro = [...PRO_STATUSES]
  const rows = await db<PlanChange[]>`
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

/** Record each change of plan in the outbox, for the CRM and telemetry. */
export async function recordPlanChanges(db: Db, changes: PlanChange[], status?: string | null): Promise<void> {
  for (const change of changes) {
    await db`
      INSERT INTO app.hosted_events (type, org, payload)
      VALUES ('plan.changed', ${change.id}, ${db.json({ from: change.from ?? null, to: change.to, ...(status !== undefined ? { status } : {}) })})
    `
  }
}

/** How many members an organization has — the seat count. */
export async function memberCount(db: Db, orgId: string): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.memberships WHERE org = ${orgId}
  `
  return row?.count ?? 0
}
