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
 * Whether the marketing checkbox may start ticked for this visitor: only when
 * the browser's time zone places them outside every opt-in region. No answer —
 * on the server, no zone, or `UTC`/`Etc/*`, which privacy-hardened browsers
 * report in place of the real one — reads as opt-in required. A guess that
 * leaves the box unticked costs a subscriber; the other kind costs consent.
 *
 * Client-only by nature, so call it from `onMounted`: rendering it on the
 * server would flip the box during hydration.
 */
export function marketingMayStartTicked(): boolean {
  if (import.meta.server) return false
  const zone = browserTimeZone()
  if (!zone || zone === 'UTC' || zone.startsWith('Etc/')) return false
  if (OPT_IN_ZONES.has(zone)) return false
  return !OPT_IN_ZONE_PREFIXES.some(prefix => zone.startsWith(prefix))
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  catch {
    return undefined
  }
}
