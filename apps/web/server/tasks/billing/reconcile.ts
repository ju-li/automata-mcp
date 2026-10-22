/**
 * Hourly: re-read every billed organization's subscription and seat count from
 * Stripe. The backstop for a lost webhook and for a seat sync that failed after
 * a membership change. Idempotent, so safe on several replicas. Does nothing on
 * a deployment without billing.
 */
export default defineTask({
  meta: {
    name: 'billing:reconcile',
    description: 'Re-read every billed organization\'s subscription and seats from Stripe',
  },
  async run() {
    if (!billingEnabled() || missingStripeSettings().length) return { result: { synced: 0, failed: 0 } }

    let synced = 0
    let failed = 0
    for (const orgId of await listBilledOrgIds()) {
      try {
        await syncOrgFromStripe(orgId)
        await syncSeats(orgId)
        synced++
      }
      catch (error) {
        failed++
        console.error(`[billing] reconcile of organization ${orgId} failed:`, error)
      }
    }
    if (synced || failed) console.info(`[billing] reconciled ${synced} organization(s), ${failed} failed`)
    return { result: { synced, failed } }
  },
})
