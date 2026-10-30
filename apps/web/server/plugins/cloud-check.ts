/**
 * Say at boot when the hosted offering is half configured. Silent on a
 * self-hosted deployment, which sets none of it.
 */
export default defineNitroPlugin(() => {
  if (!hostedMode()) return
  const config = useRuntimeConfig()
  if (!String(config.cloudAdminKey ?? '').trim()) {
    console.error('[startup] NUXT_CLOUD_URL is set but NUXT_CLOUD_ADMIN_KEY is not; the Billing page cannot reach the cloud service.')
  }
  if (!String(config.public.appUrl ?? '').trim()) {
    console.error('[startup] The hosted offering is on but NUXT_PUBLIC_APP_URL is unset; Stripe checkout cannot return to the app.')
  }
})
