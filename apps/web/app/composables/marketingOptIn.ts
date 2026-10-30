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

/** How long the page waits for the country before deciding without it. */
const REGION_LOOKUP_TIMEOUT_MS = 5000

/**
 * Whether the marketing checkbox may start ticked for this visitor: only when
 * neither signal places them in an opt-in region. The browser's time zone is
 * asked first, and a zone inside one ends it there, with no lookup; no zone,
 * or `UTC`/`Etc/*`, which privacy-hardened browsers report in place of the
 * real one, counts as inside. Otherwise the visitor's country, looked up from
 * their IP address by the cloud service (`/api/auth/consent-region`), gets a
 * veto — it catches a European on a laptop set to New York time. A lookup that
 * fails or names no country leaves the decision to the time zone rather than
 * unticking everyone. A guess that leaves the box unticked costs a subscriber;
 * the other kind costs consent.
 *
 * `lookup` is the caller's switch for the second signal: pass false off the
 * hosted offering, where the route answers 404 and there is no cloud service
 * to ask.
 *
 * Client-only by nature, so call it from `onMounted`: deciding on the server
 * would flip the box during hydration.
 */
export async function marketingMayStartTicked({ lookup }: { lookup: boolean }): Promise<boolean> {
  if (import.meta.server) return false
  if (!zoneMayStartTicked()) return false
  if (!lookup) return true
  return await consentRegion() !== 'opt-in'
}

function zoneMayStartTicked(): boolean {
  const zone = browserTimeZone()
  if (!zone || zone === 'UTC' || zone.startsWith('Etc/')) return false
  if (OPT_IN_ZONES.has(zone)) return false
  return !OPT_IN_ZONE_PREFIXES.some(prefix => zone.startsWith(prefix))
}

async function consentRegion(): Promise<'opt-in' | 'other' | 'unknown'> {
  try {
    const answer = await $fetch<{ region?: unknown }>('/api/auth/consent-region', {
      signal: AbortSignal.timeout(REGION_LOOKUP_TIMEOUT_MS),
      retry: 0,
    })
    return answer?.region === 'opt-in' || answer?.region === 'other' ? answer.region : 'unknown'
  }
  catch {
    return 'unknown'
  }
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  catch {
    return undefined
  }
}
