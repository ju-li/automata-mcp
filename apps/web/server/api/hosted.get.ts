/**
 * Whether this deployment is the hosted offering. Public, and read by the
 * layout on every page, so it touches no database: `hostedMode()` is config.
 * The UI uses it for what belongs to the hosted service alone — its terms and
 * privacy policy — and to hide what the hosted service refuses (bring-your-own
 * servers). Hiding is presentation only: the server enforces every such rule
 * itself, and nothing may depend on the UI having hidden it.
 */
export default defineEventHandler(() => ({ hosted: hostedMode() }))
