/**
 * Say at boot when billing is on but cannot take payment.
 *
 * Limits are enforced either way — a deployment that cannot sell an upgrade
 * must not fall open — but every checkout would answer 503, which is a
 * confusing state to find from the signup page. Silent when billing is off,
 * which is every self-hosted deployment.
 */
export default defineNitroPlugin(() => {
  if (!billingEnabled()) return

  const missing = missingStripeSettings()
  if (missing.length) {
    console.error(
      `[startup] NUXT_BILLING is on but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. `
      + 'Plan limits are enforced, and starting a Pro plan will fail. See docs/billing.md.',
    )
  }
  if (!String(useRuntimeConfig().public.appUrl ?? '').trim()) {
    console.error('[startup] NUXT_BILLING is on but NUXT_PUBLIC_APP_URL is unset; Stripe checkout cannot return to the app.')
  }

  // Bring every organization's enforced limits into line with its stored plan.
  // The first boot after the entitlement columns arrive is what gives existing
  // organizations their limits; after that it only repairs drift. Idempotent,
  // so every replica may run it.
  appDb()
    .then(sql => applyPlanEntitlements(sql))
    .then((changed) => {
      if (changed.length) {
        console.info(`[billing] set plan limits on ${changed.length} organization(s)`)
        for (const change of changed) {
          recordHostedEventQuietly({ type: 'plan.changed', org: change.id, payload: { from: change.from ?? null, to: change.to } })
        }
      }
    })
    .catch(error => console.error('[billing] could not apply plan limits at boot:', error))
})
