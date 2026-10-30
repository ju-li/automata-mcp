import { isIP } from 'node:net'
import { describeError } from './http-error.ts'

/**
 * Where a visitor's marketing consent box may start ticked, decided from their
 * IP address. The only file that talks to the IP lookup service (zip-prepop:
 * `POST /zip { ip }`, IP2Location LITE DB9), the way crm.ts is the only one
 * that talks to Brevo.
 *
 * The web app asks with the address it took from the request and gets back
 * one of three answers:
 *
 * - `opt-in`  the address is in a region where a pre-ticked box is not
 *             consent: the EU, EEA, UK and Switzerland (GDPR), Canada (CASL),
 *             Brazil (LGPD)
 * - `other`   it is somewhere else
 * - `unknown` the lookup failed, timed out, or had no country for it
 *
 * The browser's time zone is the web app's own first check, and `unknown`
 * leaves the decision to it, so nothing here may turn a failure into `other`.
 *
 * **Never logged:** the address, nor the lookup's answer. Failures log the
 * status alone.
 */

const LOOKUP_TIMEOUT_MS = 3000
/** How long an answer is reused for the same address. */
const CACHE_TTL_MS = 60 * 60_000
const CACHE_MAX = 10_000

export type ConsentRegion = 'opt-in' | 'other' | 'unknown'

/**
 * The opt-in regions as the lookup names them. IP2Location answers with
 * English names ("United States of America"), not codes, and its long forms
 * vary, so names are compared after `normalizeCountry` and as a prefix:
 * "Netherlands (Kingdom of the)" and "United Kingdom of Great Britain and
 * Northern Ireland" both match. Crown dependencies, Gibraltar, Åland and the
 * Faroes are included as the cautious side of "is GDPR-like law in play".
 */
const OPT_IN_COUNTRY_NAMES = [
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'czech republic', 'denmark',
  'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'republic of ireland',
  'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'the netherlands', 'holland',
  'poland', 'portugal', 'romania', 'slovakia', 'slovak republic', 'slovenia', 'spain', 'sweden',
  'iceland', 'liechtenstein', 'norway', 'svalbard',
  'united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
  'gibraltar', 'jersey', 'guernsey', 'isle of man', 'switzerland', 'aland', 'faroe',
  'guadeloupe', 'martinique', 'french guiana', 'reunion', 'mayotte', 'saint martin',
  'canada', 'brazil',
]
/** Two-letter codes for the same, should the lookup ever answer with one. */
const OPT_IN_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'EL', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'SJ',
  'GB', 'UK', 'GI', 'JE', 'GG', 'IM', 'CH', 'AX', 'FO', 'GP', 'MQ', 'GF', 'RE', 'YT', 'MF',
  'CA', 'BR',
])

export class ConsentRegions {
  private readonly lookupUrl: string
  private readonly cache = new Map<string, { region: ConsentRegion, at: number }>()

  constructor(lookupUrl: string) {
    this.lookupUrl = lookupUrl
  }

  async regionFor(ip: string): Promise<ConsentRegion> {
    if (!isIP(ip)) return 'unknown'

    const cached = this.cache.get(ip)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.region

    const country = await this.countryFor(ip)
    if (country === undefined) return 'unknown'
    const region: ConsentRegion = inOptInCountry(country) ? 'opt-in' : 'other'

    // Only answers are cached: a failure is retried on the next signup page.
    this.cache.delete(ip)
    this.cache.set(ip, { region, at: Date.now() })
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
    return region
  }

  private async countryFor(ip: string): Promise<string | undefined> {
    let response: Response
    try {
      response = await fetch(this.lookupUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip }),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      })
    }
    catch (error) {
      console.warn(`[consent-region] lookup failed: ${describeError(error)}`)
      return undefined
    }
    // 404 is the lookup's "no record for this address" — private ranges among
    // them — and not worth a log line.
    if (response.status === 404) return undefined
    if (!response.ok) {
      console.warn(`[consent-region] lookup answered ${response.status}`)
      return undefined
    }

    const body = await response.json().catch(() => undefined) as { country?: unknown } | undefined
    const country = typeof body?.country === 'string' ? body.country.trim() : ''
    return country && country.toLowerCase() !== 'unknown' && country !== '-' ? country : undefined
  }
}

export function inOptInCountry(country: string): boolean {
  const code = country.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(code)) return OPT_IN_COUNTRY_CODES.has(code)
  const name = normalizeCountry(country)
  return OPT_IN_COUNTRY_NAMES.some(listed => name === listed || name.startsWith(`${listed} `))
}

/** Lower case, accents and punctuation dropped: "Réunion" → "reunion". */
function normalizeCountry(country: string): string {
  return country
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
}
