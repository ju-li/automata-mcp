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
 * **An organization is born on Free and becomes Pro only when Stripe says so.**
 * `subscription_status` is written by `syncOrgFromStripe()` (stripe.ts) from a
 * live read of Stripe, never from a webhook payload, and nothing else writes it.
 * A signup that picked Pro and abandoned checkout is therefore a working Free
 * account, never an organization stuck halfway.
 *
 * **Lapsing deletes nothing.** An organization whose trial ended unpaid, whose
 * card failed for good, or which cancelled, reads as Free again. Everything it
 * built stays; it cannot create more while over a limit (`assertCanAdd`), and
 * only one connector token keeps answering on the MCP surface (`mcpPlanRefusal`)
 * — the oldest live token on its oldest connection — until it resubscribes,
 * which brings every other token back unchanged.
 */

export type BillingMode = 'off' | 'stripe'

export type Plan = 'unlimited' | 'free' | 'pro'

export type LimitedResource = 'connection' | 'token' | 'member'

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

export interface OrgUsage {
  connections: number
  /** Live tokens: not revoked, not expired. */
  tokens: number
  members: number
  pendingInvites: number
}

/**
 * What an organization holds, counted. Tokens carry no `org`, so they are
 * counted through their connection's.
 */
export async function orgUsage(db: Db, orgId: string): Promise<OrgUsage> {
  const [row] = await db<OrgUsage[]>`
    SELECT
      (SELECT count(*)::int FROM app.instances WHERE org = ${orgId}) AS connections,
      (SELECT count(*)::int FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
        WHERE i.org = ${orgId} AND NOT t.revoked
          AND (t.expires_at IS NULL OR t.expires_at > now())) AS tokens,
      (SELECT count(*)::int FROM app.memberships WHERE org = ${orgId}) AS members,
      (SELECT count(*)::int FROM app.invitations
        WHERE org = ${orgId} AND NOT revoked AND accepted_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())) AS "pendingInvites"
  `
  return row ?? { connections: 0, tokens: 0, members: 0, pendingInvites: 0 }
}

/** Whether an organization on this plan holds more than the plan allows. */
export function overLimit(plan: Plan, usage: OrgUsage): boolean {
  if (plan !== 'free') return false
  return usage.connections > FREE_LIMITS.connections
    || usage.tokens > FREE_LIMITS.tokens
    || usage.members > FREE_LIMITS.members
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

const LIMIT_MESSAGES: Record<LimitedResource, string> = {
  connection: 'The Free plan includes one connection. Start a Pro trial to add more.',
  token: 'The Free plan includes one connector token. Revoke the existing one, or start a Pro trial for more.',
  member: 'The Free plan is for one user. Start a Pro trial to invite your team.',
}

/**
 * The refusal. 402 with `data.code = 'plan_limit'`, which the UI keys on to
 * offer the upgrade rather than show a bare error.
 */
function planLimitError(what: LimitedResource) {
  return createError({
    statusCode: 402,
    statusMessage: LIMIT_MESSAGES[what],
    data: { code: 'plan_limit', resource: what },
  })
}

/**
 * Refuse to add one more of something the organization's plan has no room for.
 *
 * Takes `Db` so it runs inside the caller's transaction — the insert it guards
 * stands or falls with it. The organization row is locked `FOR UPDATE` before
 * counting, so two racing adds take turns and the second one sees the first.
 * A no-op without billing, and on Pro.
 *
 * `includePendingInvites` is for creating an invitation: on Free a pending
 * invitation is a seat already promised, so inviting is refused while one is
 * outstanding even though the member count alone would allow it.
 */
export async function assertCanAdd(
  db: Db,
  orgId: string,
  what: LimitedResource,
  options: { includePendingInvites?: boolean } = {},
): Promise<void> {
  if (!billingEnabled()) return

  const [org] = await db<Pick<AppOrganizationBilling, 'subscription_status'>[]>`
    SELECT subscription_status FROM app.organizations WHERE id = ${orgId} FOR UPDATE
  `
  if (effectivePlan(org) !== 'free') return

  const usage = await orgUsage(db, orgId)
  const full = what === 'connection'
    ? usage.connections >= FREE_LIMITS.connections
    : what === 'token'
      ? usage.tokens >= FREE_LIMITS.tokens
      : usage.members + (options.includePendingInvites ? usage.pendingInvites : 0) >= FREE_LIMITS.members

  if (full) throw planLimitError(what)
}

/**
 * Whether one connector token may answer on the MCP surface under its
 * organization's plan, or the refusal to send instead.
 *
 * On Free only one token works: the oldest live token on the organization's
 * oldest connection. Within the limits that is simply its token; over them —
 * a lapsed trial, or two creates that raced past `assertCanAdd` — it is a
 * deterministic choice, so the same connector keeps working on every request
 * and the owner can tell which one it is.
 *
 * The refusal is **403, never 401**. A 401 tells an MCP client its credential
 * is bad and invites it to throw the token away; this one comes back to life
 * the moment the organization resubscribes, with nothing to reconfigure.
 *
 * A read failure is a 503 like every other auth read — never a refusal.
 */
export async function mcpPlanRefusal(orgId: string | undefined, tokenId: string): Promise<Response | undefined> {
  if (!billingEnabled() || !orgId) return undefined

  let row: { subscription_status?: string, allowed_token?: string } | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql`
      SELECT o.subscription_status,
             (SELECT t.id FROM app.mcp_tokens t
               WHERE t.instance = (
                 SELECT i.id FROM app.instances i WHERE i.org = o.id ORDER BY i.created, i.id LIMIT 1
               )
                 AND NOT t.revoked AND (t.expires_at IS NULL OR t.expires_at > now())
               ORDER BY t.created, t.id LIMIT 1) AS allowed_token
      FROM app.organizations o WHERE o.id = ${orgId}
    `
  }
  catch (error) {
    console.error('[billing] could not read the plan for an MCP request:', error)
    throw appDbUnavailable(error)
  }

  if (effectivePlan(row) !== 'free') return undefined
  if (row?.allowed_token === tokenId) return undefined

  // A handled refusal is invisible to Nitro; say which token and why, since
  // "my connector stopped working" is the first thing a lapsed owner reports.
  console.warn(`[billing] token ${tokenId} refused: organization ${orgId} is on Free and this is not its one allowed token`)

  const appUrl = String(useRuntimeConfig().public.appUrl ?? '').replace(/\/+$/, '')
  const where = appUrl ? ` Upgrade at ${appUrl}/billing to use it again.` : ' An admin can upgrade on the Billing page to use it again.'
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32002,
        message: 'This organization is on the Free plan, which covers one connector, and this is not it.' + where,
      },
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}
