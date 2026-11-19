/**
 * How far back a Telegram account's history is fetched when its organization
 * imports recent history only (`recent_history_only`, the flag that also limits
 * WhatsApp). WhatsApp's recent slice is WhatsApp's choice; Telegram has no such
 * slice, so the limit is a number of days, which the bridge enforces per
 * session. Shared so the server's cap and the UI's wording cannot differ.
 */
export const TELEGRAM_RECENT_HISTORY_DAYS = 90

/**
 * The most older messages fetched for one chat when a Telegram account is
 * linked, on every plan: whichever of this and the day limit comes first ends
 * that chat's history. A busy group reaches it in days, well inside
 * {@link TELEGRAM_RECENT_HISTORY_DAYS}, so plan copy must name both.
 *
 * Wording only — the bridge enforces its own `TELEGRAM_BACKFILL_MAX_PER_CHAT`,
 * whose default is this number. A deployment that sets that variable to
 * something else must change this too, or the copy promises the wrong figure.
 */
export const TELEGRAM_HISTORY_MESSAGES_PER_CHAT = 20_000

/**
 * The bridge's default `TELEGRAM_BACKFILL_DAYS`: how far back a Telegram
 * account's history goes when no plan limits it. Wording only, like the above.
 */
export const TELEGRAM_FULL_HISTORY_DAYS = 365
