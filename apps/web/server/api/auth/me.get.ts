import type { AppUser } from '~~/server/utils/app-db'
import type { Plan } from '~~/server/utils/billing'

/**
 * Current session, or `{ user: null }`. Deliberately not a 401: the client
 * middleware calls this on every navigation to decide where to send the user,
 * and an error response would make "signed out" indistinguishable from "the
 * request failed".
 *
 * The organization comes back with it, because every page needs the role and
 * fetching it separately would mean a second round-trip on every navigation.
 *
 * `membership: null` is a real, reachable answer and not an error: a record
 * whose organization was deleted, or one created before this existed. This route
 * therefore does NOT use `requireMembership`, which throws — it reports the
 * state and lets the client route somewhere that explains it. A backend fault
 * still becomes a 503, so an outage is never mistaken for "you were removed".
 */
/**
 * The plan and whether the organization holds more than it allows, so every
 * page can show limits and the over-limit banner without asking again. Nothing
 * at all without billing — no query, no field — so a self-hosted UI never
 * learns plans exist. A read failure is a 503 like the membership read.
 */
async function planSummary(orgId: string): Promise<{ plan: Plan, overLimit: boolean } | undefined> {
  if (!billingEnabled()) return undefined
  try {
    const sql = await appDb()
    const [org, usage] = await Promise.all([loadOrgBilling(sql, orgId), orgUsage(sql, orgId)])
    const plan = effectivePlan(org)
    return { plan, overLimit: overLimit(plan, usage) }
  }
  catch (error) {
    console.error('[billing] could not read the plan for organization', orgId, error)
    throw appDbUnavailable(error)
  }
}

export default defineEventHandler(async (event) => {
  const user = event.context.user as AppUser | undefined
  if (!user) return { user: null }

  const actor = await loadActor(user)
  const plan = actor ? await planSummary(actor.org.id) : undefined

  return {
    user: { id: user.id, email: user.email, name: user.name },
    membership: actor
      ? { role: actor.role, org: { id: actor.org.id, name: actor.org.name, ...plan } }
      : null,
  }
})
