import { version } from '../../../../package.json'
import type { Actor } from './org'

/**
 * First-run setup: the five-step walk-through on `/welcome` (pick a connector,
 * name it and give credentials, scan for WhatsApp/Telegram, mint the first
 * token, and on a self-hosted install offer update mail).
 *
 * **Only the first admin of a new organization sees it.** `createOrganizationFor`
 * — the one path that makes an organization, run by signup and by signup's
 * verification — writes the user's id to `app.organizations.onboarding_for`;
 * picking a connector clears it (as do finishing and skipping), so setup is
 * offered until it is started, never again after it is abandoned. Existing organizations have none, invited
 * members never match it, and accepting an invitation moves a user to an
 * organization that does not name them. Presentation only: every step uses the
 * ordinary routes and their checks.
 *
 * **Update mail (self-hosted only).** The admin's address leaves the install
 * only when they submit it, to `selfHostUpdatesUrl` (our cloud service's
 * `POST /self-host/updates`, apps/cloud/src/self-host-updates.ts). The hosted
 * offering never offers it — its users are already ours to mail — and an
 * operator turns it off with `NUXT_SELF_HOST_UPDATES_URL=off`.
 */

const UPDATES_TIMEOUT_MS = 10_000
const UPDATES_PER_HOUR = 5
const HOUR_MS = 60 * 60_000
const updateAttempts = new Map<string, number[]>()

/** What `/api/auth/me` says about setup: present only while it is this user's to do. */
export function onboardingFor(actor: Actor): { updates: boolean } | undefined {
  if (actor.role !== 'admin' || actor.org.onboarding_for !== actor.user.id) return undefined
  return { updates: selfHostUpdatesUrl() !== undefined }
}

/** Finish or skip setup. Conditional on it still being this user's, so it never clears someone else's. */
export async function finishOnboarding(actor: Actor): Promise<void> {
  try {
    const sql = await appDb()
    await sql`
      UPDATE app.organizations SET onboarding_for = NULL
      WHERE id = ${actor.org.id} AND onboarding_for = ${actor.user.id}
    `
  }
  catch (error) {
    console.error('[onboarding] could not finish setup for organization', actor.org.id, error)
    throw appDbUnavailable(error)
  }
}

/** Where update signups go, or `undefined` where none are offered. */
export function selfHostUpdatesUrl(): string | undefined {
  if (hostedMode()) return undefined
  const url = String(useRuntimeConfig().selfHostUpdatesUrl ?? '').trim()
  if (!url || url.toLowerCase() === 'off' || !/^https?:\/\//i.test(url)) return undefined
  return url
}

/**
 * Hand one address to our update list. Throttled per admin (a speed bump: the
 * cloud service throttles per install too). Relays the cloud's 4xx message,
 * which is written for the person in the browser; anything else is logged
 * (without the address) and answered 503.
 *
 * Answers whether the address must confirm by email first (the cloud's double
 * opt-in), so the page can say so; an older cloud that doesn't say = no.
 */
export async function subscribeToUpdates(actor: Actor, email: string): Promise<{ confirm: boolean }> {
  const url = selfHostUpdatesUrl()
  if (!url) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const now = Date.now()
  const recent = (updateAttempts.get(actor.user.id) ?? []).filter(at => now - at < HOUR_MS)
  if (recent.length >= UPDATES_PER_HOUR) {
    throw createError({ statusCode: 429, statusMessage: 'Too many signups. Try again later.' })
  }
  updateAttempts.set(actor.user.id, [...recent, now])
  if (updateAttempts.size > 10_000) {
    for (const [key, times] of updateAttempts) if (times.every(at => now - at >= HOUR_MS)) updateAttempts.delete(key)
  }

  try {
    const answer = await $fetch<{ confirm?: unknown }>(url, {
      method: 'POST',
      body: { email, version },
      signal: AbortSignal.timeout(UPDATES_TIMEOUT_MS),
      retry: 0,
    })
    return { confirm: answer?.confirm === true }
  }
  catch (error: any) {
    const status = Number(error?.response?.status ?? 0)
    const message = typeof error?.data?.error === 'string' ? error.data.error : undefined
    if (status >= 400 && status < 500 && message) {
      throw createError({ statusCode: status, statusMessage: message.slice(0, 200) })
    }
    console.error(`[onboarding] update signup could not reach ${new URL(url).host}: ${status || error?.name || 'no answer'}`)
    throw createError({ statusCode: 503, statusMessage: 'The update list could not be reached. Try again later.' })
  }
}
