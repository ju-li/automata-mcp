/**
 * Time zones of the places where a pre-ticked marketing box is not consent:
 * the EU, EEA, UK and Switzerland (GDPR), Canada (CASL) and Brazil (LGPD).
 * Every `Europe/*` zone counts, non-EU ones included — erring that way only
 * leaves a box unticked. Outside `Europe/` it names the territories that are
 * inside: Cyprus, the Atlantic islands, Ceuta, Svalbard, the EU's outermost
 * regions, every Canadian and Brazilian zone, and legacy aliases a browser may
 * still report. Extend it here to add a region.
 */
const OPT_IN_ZONE_PREFIXES = ['Europe/', 'Canada/', 'Brazil/']
const OPT_IN_ZONES = new Set([
  'Asia/Nicosia', 'Asia/Famagusta',
  'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Reykjavik', 'Atlantic/Faroe',
  'Africa/Ceuta', 'Arctic/Longyearbyen',
  'America/Guadeloupe', 'America/Martinique', 'America/Cayenne', 'America/Marigot',
  'Indian/Reunion', 'Indian/Mayotte',
  'GB', 'GB-Eire', 'Eire', 'Iceland', 'Poland', 'Portugal', 'CET', 'EET', 'MET', 'WET',
  // Canada
  'America/St_Johns', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton', 'America/Goose_Bay',
  'America/Toronto', 'America/Montreal', 'America/Nipigon', 'America/Thunder_Bay', 'America/Iqaluit',
  'America/Pangnirtung', 'America/Atikokan', 'America/Coral_Harbour', 'America/Blanc-Sablon',
  'America/Winnipeg', 'America/Rainy_River', 'America/Rankin_Inlet', 'America/Resolute',
  'America/Regina', 'America/Swift_Current', 'America/Edmonton', 'America/Cambridge_Bay',
  'America/Yellowknife', 'America/Inuvik', 'America/Creston', 'America/Dawson_Creek',
  'America/Fort_Nelson', 'America/Whitehorse', 'America/Dawson', 'America/Vancouver',
  // Brazil
  'America/Noronha', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Araguaina',
  'America/Maceio', 'America/Bahia', 'America/Sao_Paulo', 'America/Campo_Grande', 'America/Cuiaba',
  'America/Santarem', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Manaus',
  'America/Eirunepe', 'America/Rio_Branco', 'America/Porto_Acre',
])

/**
 * The same regions as countries, for the IP lookup. The service answers with
 * an English country name ("United States of America"), not a code, so names
 * are matched after `normalizeCountry` and as a prefix — "Netherlands (Kingdom
 * of the)" and "United Kingdom of Great Britain and Northern Ireland" both
 * match. Two-letter codes are accepted too, should the answer ever be one.
 * Crown dependencies, Gibraltar, Åland and the Faroes are included as the
 * cautious side of "is GDPR-like law in play".
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
const OPT_IN_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'EL', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'SJ',
  'GB', 'UK', 'GI', 'JE', 'GG', 'IM', 'CH', 'AX', 'FO', 'GP', 'MQ', 'GF', 'RE', 'YT', 'MF',
  'CA', 'BR',
])

/** The visitor's country, as seen by the IP lookup; hosted offering only. */
const COUNTRY_LOOKUP_URL = 'https://api.revbull-services.com/ip-to-zip/zip'
const COUNTRY_LOOKUP_TIMEOUT_MS = 3000

/**
 * Whether the marketing checkbox may start ticked for this visitor: only when
 * neither signal places them in an opt-in region. The browser's time zone is
 * asked first, and a zone inside one ends it there, with no lookup; no zone,
 * or `UTC`/`Etc/*`, which privacy-hardened browsers report in place of the
 * real one, counts as inside. Otherwise the IP lookup gets a veto — it catches
 * a European on a laptop set to New York time. A lookup that fails or names no
 * country leaves the decision to the time zone rather than unticking everyone.
 * A guess that leaves the box unticked costs a subscriber; the other kind
 * costs consent.
 *
 * `lookup` is the caller's switch for the second signal: pass false off the
 * hosted offering, so a self-hosted deployment's signup page never sends its
 * visitors' addresses to our service.
 *
 * Client-only by nature, so call it from `onMounted`: deciding on the server
 * would flip the box during hydration.
 */
export async function marketingMayStartTicked({ lookup }: { lookup: boolean }): Promise<boolean> {
  if (import.meta.server) return false
  if (!zoneMayStartTicked()) return false
  if (!lookup) return true
  const country = await visitorCountry()
  return country === undefined || !inOptInCountry(country)
}

function zoneMayStartTicked(): boolean {
  const zone = browserTimeZone()
  if (!zone || zone === 'UTC' || zone.startsWith('Etc/')) return false
  if (OPT_IN_ZONES.has(zone)) return false
  return !OPT_IN_ZONE_PREFIXES.some(prefix => zone.startsWith(prefix))
}

async function visitorCountry(): Promise<string | undefined> {
  try {
    const answer = await $fetch<{ country?: unknown }>(COUNTRY_LOOKUP_URL, {
      signal: AbortSignal.timeout(COUNTRY_LOOKUP_TIMEOUT_MS),
      retry: 0,
    })
    return typeof answer?.country === 'string' && answer.country.trim() ? answer.country : undefined
  }
  catch {
    return undefined
  }
}

function inOptInCountry(country: string): boolean {
  const code = country.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(code)) return OPT_IN_COUNTRY_CODES.has(code)
  const name = normalizeCountry(country)
  return OPT_IN_COUNTRY_NAMES.some(listed => name === listed || name.startsWith(`${listed} `))
}

/** Lower case, accents and punctuation dropped: "Réunion" → "reunion". */
function normalizeCountry(country: string): string {
  return country
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  catch {
    return undefined
  }
}
