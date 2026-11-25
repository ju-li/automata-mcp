/**
 * What keeps secrets in our URLs out of PostHog: the `init` options that close
 * channels which never pass `before_send`, and the scrubbing `before_send`
 * applies to everything else. No imports, so test/analytics-privacy.test.mjs
 * loads it in plain Node. Used by plugins/posthog.client.ts.
 *
 * Our pages carry bearer secrets in the URL: `?token=` on the verification and
 * password-reset links, the invitation code in `/invite/<code>`. posthog-js
 * records the page it was loaded on (`$initial_person_info`) at `init` and
 * sends it back as `$initial_current_url` — through `$set_once` on events,
 * which `before_send` scrubs, but also in the `/flags` request body, which it
 * never sees. Rules easy to undo:
 *
 * - **Feature flags off** (`advanced_disable_flags`). The app uses none, and
 *   the flags request carried the raw first-page URL — a live reset token —
 *   for every visitor, opted out included. Turning flags on needs that channel
 *   closed some other way first.
 * - **`token` and `code` masked where the URL is recorded**, as a second line
 *   for any other channel a posthog-js bump adds.
 * - **Every URL-ish property scrubbed in `before_send`**: query and hash
 *   dropped, our own secret paths replaced. A new page with a secret in its
 *   path joins `SECRET_PATHS`.
 */

export const PRIVACY_OPTIONS: {
  advanced_disable_flags: true
  mask_personal_data_properties: true
  custom_personal_data_properties: string[]
} = {
  advanced_disable_flags: true,
  mask_personal_data_properties: true,
  custom_personal_data_properties: ['token', 'code'],
}

const SECRET_PATHS: RegExp[] = [/^\/invite\/[^/]+/]

function scrubPath(path: string): string {
  for (const pattern of SECRET_PATHS) {
    if (pattern.test(path)) return path.replace(pattern, m => `${m.slice(0, m.lastIndexOf('/'))}/:code`)
  }
  return path
}

/** `ownOrigin` = this app's origin: only our own pages carry our secret paths. */
export function scrubUrl(value: string, ownOrigin: string): string {
  if (value.startsWith('/')) return scrubPath(value.split(/[?#]/, 1)[0] ?? '')
  try {
    const url = new URL(value)
    // A referrer from elsewhere still loses its query, which may carry someone else's.
    return `${url.origin}${url.origin === ownOrigin ? scrubPath(url.pathname) : url.pathname}`
  }
  catch {
    return value
  }
}

/** In place: every url / pathname / referrer string, including inside `$set` and `$set_once`. */
export function scrubProperties(properties: Record<string, unknown> | undefined, ownOrigin: string): void {
  if (!properties) return
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string' && /url|pathname|referrer/i.test(key)) properties[key] = scrubUrl(value, ownOrigin)
    else if (value && typeof value === 'object' && (key === '$set' || key === '$set_once')) {
      scrubProperties(value as Record<string, unknown>, ownOrigin)
    }
  }
}
