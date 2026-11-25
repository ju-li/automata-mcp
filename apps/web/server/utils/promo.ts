/**
 * The promotion banner, configured by one env var, `NUXT_PROMO`:
 *
 *     NUXT_PROMO=Thanksgiving,2026-12-01,THANKSGIVING2026,50% off Pro for 6 months
 *
 * Four comma-separated fields — holiday, end date, code, details. Only the
 * first three commas split, so the details may contain commas. The end date is
 * inclusive and read as a US Eastern day (the day the revenue tables use too):
 * the banner shows through the end of that day in New York, then disappears
 * with no redeploy. Zero padding is optional (`2026-12-1` is fine).
 *
 * The banner is presentation only. The code is a Stripe promotion code typed on
 * the Checkout page (`allow_promotion_codes` in apps/cloud/src/billing.ts); its
 * validity and expiry are Stripe's, and ending the banner does not end the code.
 *
 * A malformed value shows nothing and is logged once per value, since an
 * unhandled typo would otherwise look exactly like "no promotion running".
 */

export interface Promo {
  holiday: string
  /** Last day shown, `YYYY-MM-DD`, US Eastern. */
  endsOn: string
  code: string
  details: string
}

const PROMO_TIME_ZONE = 'America/New_York'

let parsedFor: string | undefined
let parsed: Promo | undefined

function parsePromo(raw: string): Promo | undefined {
  const parts = raw.split(',')
  if (parts.length < 4) return undefined
  const [holiday, date, code] = parts.slice(0, 3).map(part => part.trim())
  const details = parts.slice(3).join(',').trim()
  if (!holiday || !code || !details) return undefined

  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date ?? '')
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // Round-trip through Date to refuse 2026-02-30 and the like.
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined

  const endsOn = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { holiday: holiday!, endsOn, code: code!, details }
}

function configuredPromo(): Promo | undefined {
  const raw = String(useRuntimeConfig().promo ?? '').trim()
  if (raw === parsedFor) return parsed
  parsedFor = raw
  parsed = raw ? parsePromo(raw) : undefined
  if (raw && !parsed) {
    console.error(
      '[promo] NUXT_PROMO is not "Holiday,YYYY-MM-DD,CODE,details"; no promotion banner is shown. Value:',
      JSON.stringify(raw),
    )
  }
  return parsed
}

/** Today in US Eastern, `YYYY-MM-DD` (en-CA formats dates that way). */
function easternToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PROMO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** The configured promotion while it runs, else `undefined`. */
export function activePromo(now = new Date()): Promo | undefined {
  const promo = configuredPromo()
  if (!promo) return undefined
  return easternToday(now) <= promo.endsOn ? promo : undefined
}
