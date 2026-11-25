/**
 * Say at boot when the hosted offering cannot issue media download links.
 *
 * Files over the inline limit are handed back as signed links, sealed with
 * `NUXT_MEDIA_URL_SECRET`. Without it each process seals with its own random
 * key, so on several replicas, or after a deploy, a link answers 404. Hosted
 * mode therefore issues no links until the secret is set (`mediaLinkBlocker` in
 * media.ts): small files still come back inline, larger ones are refused with
 * the setting named. Announced once here, where an operator will see it.
 */
export default defineNitroPlugin(() => {
  if (mediaLinkBlocker() !== 'NUXT_MEDIA_URL_SECRET') return
  console.error(
    '[startup] NUXT_MEDIA_URL_SECRET is not set. Media downloads over the inline limit need it '
    + 'on the hosted offering, so they are refused until it is set; smaller files still work. '
    + 'See docs/whatsapp.md "Downloading media".',
  )
})
