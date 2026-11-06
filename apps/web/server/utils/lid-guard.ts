import type { AppInstance } from './app-db'

/**
 * Refuses a send whose recipient is a LID's digits passed as a phone number (#113).
 *
 * A LID (`79972425314508@lid`) is WhatsApp's per-person privacy alias. Its local
 * part looks like a phone number and is not one: no country code, no relation to
 * the person's number. A model that strips the suffix and passes the bare digits
 * to `send-text-message` has Evolution treat them as a phone number, and the
 * message either fails or reaches whoever owns that number. It cannot be unsent.
 * The tool description and server instructions steer away from it; this is the
 * check underneath them.
 *
 * **Fails closed only on a positive match.** Cold sends to new numbers are a
 * supported use, so digits this account has never seen as a LID go through, and
 * so does a send when the lookup cannot answer (logged, never silent) — the
 * alternative is that a message-database outage stops every send. A connection
 * with no message database is not checked at all: it has no read tools either,
 * so the model has no LID digits from us to misuse except through `list-chats`'
 * `findChats` walk, which shows them only as full JIDs.
 *
 * **What counts as "seen"**: any `…@lid` a message on this account names — chat,
 * group sender, alternate form, @-mention (`lidLocalParts` in evolution-db.ts).
 * Those are what the read tools surface, mentions especially: an unresolved one
 * stays as `@79972425314508` in the text, the likeliest digits to be lifted.
 *
 * **Cost.** The full set is one scan of the account's rows, so it is cached per
 * connection for `TTL_MS` and rebuilt by the first send after that. Between
 * rebuilds, a send whose digits are not in the set pays one more scan that only
 * extracts from messages newer than the build (less `RECENT_MARGIN_S`, since a
 * message delivered after a reconnect carries its original, older timestamp),
 * which stops at the first match — so a LID first seen a minute ago is caught
 * without rebuilding. History import writes old timestamps all at once, but only
 * at pairing; the next rebuild picks it up.
 *
 * **Not a normaliser.** `recipientDigits` approximates Evolution's `createJid()`
 * only to decide which digits a value *would* be sent to, and is used only to
 * refuse. Nothing is rewritten and nothing is addressed by what it returns, so
 * "never normalise JIDs locally" is not in play: a mismatch costs a missed
 * refusal (today's behaviour) or a refusal of digits this account knows as a LID.
 */

const TTL_MS = 10 * 60_000
/** After a failed build, how long sends rely on the recent check alone. */
const RETRY_MS = 60_000
const RECENT_MARGIN_S = 24 * 60 * 60
/** Connections held at once; oldest-built dropped first. */
const MAX_ENTRIES = 500

interface Entry {
  lids?: Set<string>
  /** Unix seconds when the build that produced `lids` started. */
  builtAt: number
  expiresAt: number
}

const entries = new Map<string, Entry>()
const building = new Map<string, Promise<Entry>>()

/**
 * The digits Evolution would send to when `number` is not a JID it passes
 * through — or `undefined` when it is one, or holds no digits.
 *
 * 2.3.7's `createJid()` returns a value containing `@g.us`, `@s.whatsapp.net`,
 * `@lid` or `@broadcast` unchanged; anything else is cut at `:` and `@` and
 * stripped to digits, so `79972425314508@c.us` is a phone number to it too.
 */
export function recipientDigits(number: string): string | undefined {
  if (/@(?:lid|s\.whatsapp\.net|g\.us|broadcast)/i.test(number)) return undefined
  const digits = number.replace(/:\d+/, '').split(':')[0]!.split('@')[0]!.replace(/\D/g, '')
  return digits || undefined
}

export async function assertNotBareLid(instance: AppInstance, number: string): Promise<void> {
  const digits = recipientDigits(number)
  if (!digits || !canReadMessages(instance)) return

  const entry = await knownLids(instance)
  if (entry.lids?.has(digits)) refuse(number, digits)

  const since = Math.floor(entry.builtAt) - RECENT_MARGIN_S
  let recent: Set<string>
  try {
    recent = await lidLocalParts(instance, { since, localPart: digits })
  }
  catch (error) {
    console.error(`[lid-guard] could not check recent messages for connection ${instance.id}; sending unchecked:`, error)
    return
  }
  if (recent.has(digits)) {
    // Known now; save the next send to these digits the extra scan.
    entry.lids?.add(digits)
    refuse(number, digits)
  }
}

function refuse(number: string, digits: string): never {
  throw createError({
    statusCode: 422,
    message: `Not sent: "${number}" is the digits of a WhatsApp LID on this account (${digits}@lid), `
      + 'a privacy alias and not a phone number. Sending to it as a number would reach whoever '
      + `owns that number, if anyone. To reply in that chat, pass its full jid "${digits}@lid" as number.`,
  })
}

async function knownLids(instance: AppInstance): Promise<Entry> {
  const cached = entries.get(instance.id)
  if (cached && Date.now() < cached.expiresAt) return cached

  let pending = building.get(instance.id)
  if (!pending) {
    pending = build(instance, cached).finally(() => building.delete(instance.id))
    building.set(instance.id, pending)
  }
  return pending
}

async function build(instance: AppInstance, previous: Entry | undefined): Promise<Entry> {
  const startedAt = Date.now()
  let entry: Entry
  try {
    const lids = await lidLocalParts(instance)
    entry = { lids, builtAt: startedAt / 1000, expiresAt: startedAt + TTL_MS }
  }
  catch (error) {
    console.error(`[lid-guard] could not read known LIDs for connection ${instance.id}:`, error)
    // Keep a stale set rather than none — a LID does not stop being one. With
    // no set at all, the recent check reaches back from the last good build, or
    // from now; either way only its margin is covered until a build succeeds.
    entry = previous
      ? { ...previous, expiresAt: startedAt + RETRY_MS }
      : { builtAt: startedAt / 1000, expiresAt: startedAt + RETRY_MS }
  }

  entries.delete(instance.id)
  entries.set(instance.id, entry)
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  return entry
}
