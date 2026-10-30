/**
 * Whether this deployment is the hosted offering. Public, and read by the
 * layout on every page, so it touches no database: `hostedMode()` is config.
 * The UI uses it for what belongs to the hosted service alone — its terms and
 * privacy policy — never to gate anything the server enforces.
 */
export default defineEventHandler(() => ({ hosted: hostedMode() }))
