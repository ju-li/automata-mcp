import type { CaptureResult, PostHog } from 'posthog-js'

/**
 * Product analytics (PostHog) in the browser. Hosted offering only: needs
 * `NUXT_PUBLIC_POSTHOG_KEY` *and* `/api/hosted` saying hosted, so a
 * self-hosted deployment never loads the script even if the key is set. The
 * MCP surface is untouched — this runs in the web UI alone.
 *
 * Rules easy to undo:
 *
 * - **Cookieless.** `persistence: 'memory'`: no PostHog cookie or
 *   localStorage, so no consent banner; an anonymous visitor is a new person on
 *   every page load until sign-in identifies them. The one thing stored is the
 *   opt-out flag (localStorage, never a cookie), written only for an opted-out
 *   user — honouring their organization's choice on the next load, before the
 *   session is known. Opting back in *clears* it rather than storing a yes.
 * - **Follows the organization's telemetry switch** (`org.telemetry` on
 *   `/api/auth/me`): required on Free, the admin's choice on Pro. Off → one
 *   `telemetry_opted_out` event naming the user id (so PostHog knows who left),
 *   then `opt_out_capturing()`: nothing more is sent from this browser. No
 *   email on that event. Signed out, or signed in without an organization,
 *   captures (signup funnel); opt-out stays stored until someone whose
 *   organization records signs in here.
 * - **Identify sends email and name** only for users whose organization
 *   records telemetry; the organization is a PostHog group.
 * - **Nothing typed or shown leaves the page.** `mask_all_text` and
 *   `mask_all_element_attributes`: autocapture would otherwise send the text of
 *   a clicked message row, chat name or DSN field. No session replay, surveys,
 *   heatmaps or exception capture.
 * - **Secrets in URLs never leave**: feature flags off (their request carried
 *   the raw first-page URL past `before_send`), `token`/`code` masked where
 *   the URL is recorded, and every URL scrubbed in `before_send`. All of it in
 *   `utils/analyticsPrivacy.ts`, with its rules; a new page with a secret in
 *   its path joins `SECRET_PATHS` there.
 *
 * Product events (connection and token created/removed) go through `track()`
 * in `composables/analytics.ts`, never `posthog.capture` directly.
 */

/**
 * True until the session has been read once. `init` captures the first
 * pageview straight away, before anyone knows whether this user's organization
 * records — so it is held back here, and sent by `apply` only if it does.
 */
let undecided = true
let heldPageview = false

function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event
  if (undecided) {
    if (event.event === '$pageview') heldPageview = true
    return null
  }
  scrubProperties(event.properties, location.origin)
  scrubProperties(event.$set, location.origin)
  scrubProperties(event.$set_once, location.origin)
  return event
}

export default defineNuxtPlugin(async () => {
  const { posthogKey, posthogHost, posthogUiHost } = useRuntimeConfig().public
  const key = String(posthogKey ?? '').trim()
  if (!key) return

  let hosted = false
  try {
    hosted = (await $fetch<{ hosted: boolean }>('/api/hosted')).hosted === true
  }
  catch {
    // Unknown = not hosted: analytics is never worth an error, and a
    // self-hosted page must never load it by mistake.
  }
  if (!hosted) return

  const { default: posthog } = await import('posthog-js') as { default: PostHog }
  const { user, org, loaded } = useSession()

  posthog.init(key, {
    api_host: String(posthogHost ?? '').trim() || 'https://r.getautomata.app',
    ui_host: String(posthogUiHost ?? '').trim() || 'https://us.posthog.com',
    defaults: '2026-05-30',
    persistence: 'memory',
    opt_out_capturing_persistence_type: 'localStorage',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    autocapture: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_conversations: true,
    disable_product_tours: true,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    ...PRIVACY_OPTIONS,
    before_send: beforeSend,
  })
  setAnalyticsClient(posthog)

  let identifiedAs: string | undefined

  function apply() {
    if (!loaded.value) return
    const signedIn = user.value
    const organization = org.value
    const first = undecided
    undecided = false

    if (!signedIn) {
      // Signed out: forget whoever was identified, so the next visitor is not
      // counted as them. A stored opt-out stays (see the header).
      if (identifiedAs) {
        posthog.reset()
        identifiedAs = undefined
      }
      if (first && heldPageview) posthog.capture('$pageview')
      return
    }

    // No organization (removed, or between orgs): nothing has said no.
    const recording = organization ? organization.telemetry !== false : true

    if (!recording) {
      if (posthog.get_explicit_consent_status() === 'denied') return
      // The opt-out signal: who, and that they left. Id only — no email for
      // someone whose organization turned telemetry off.
      if (identifiedAs !== signedIn.id) posthog.identify(signedIn.id)
      posthog.capture('telemetry_opted_out', {
        $set: { telemetry_opted_out: true },
        ...(organization ? { $groups: { organization: organization.id } } : {}),
      }, { send_instantly: true })
      posthog.opt_out_capturing()
      identifiedAs = signedIn.id
      return
    }

    if (posthog.get_explicit_consent_status() === 'denied') {
      // Back on (switch flipped, or a recording org's user on a browser an
      // opted-out user used). Opting in restarts the send queue and captures
      // the pageview; the stored yes is then cleared, so only a no is stored.
      posthog.opt_in_capturing({ captureEventName: false })
      posthog.clear_opt_in_out_capturing()
    }
    else if (first && heldPageview) {
      posthog.capture('$pageview')
    }
    posthog.identify(signedIn.id, {
      email: signedIn.email,
      ...(signedIn.name ? { name: signedIn.name } : {}),
      telemetry_opted_out: false,
    })
    if (organization) {
      posthog.group('organization', organization.id, {
        name: organization.name,
        ...(organization.plan ? { plan: organization.plan } : {}),
      })
    }
    identifiedAs = signedIn.id
  }

  watch(
    () => [loaded.value, user.value?.id, user.value?.email, user.value?.name, org.value?.id, org.value?.name, org.value?.plan, org.value?.telemetry],
    apply,
    { immediate: true },
  )
})
