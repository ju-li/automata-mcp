import type { AppInstance } from './app-db'
import { canReadMessages, readLidLinks } from './evolution-db'
import type { LidLinkRow } from './evolution-db'
import { staleWhileFailing } from './lookup-cache'

/**
 * One WhatsApp person, two chat ids: which LID and which phone-number JID belong
 * together on this account.
 *
 * WhatsApp addresses a person either by phone number (`…@s.whatsapp.net`) or by
 * a LID (`…@lid`, a privacy alias whose digits are **not** a phone number), and
 * Evolution stores each message under whichever one that message used. Someone
 * who moved from one to the other is two chats in `"Message"`, each holding part
 * of the conversation (#118).
 *
 * **Only links WhatsApp gave us, never constructed.** The sole source is
 * `key.remoteJidAlt` on this account's own 1:1 rows (`readLidLinks`). Nothing is
 * derived from digits, names or another account's data, and the shape checks
 * below validate a stored value — they never build one. "Never normalise JIDs
 * locally" stands.
 *
 * **Partial by construction (#116).** History import never carries the
 * alternate form, so a LID chat with only imported messages has no link, and
 * absence here means "unknown", never "this person has no phone number".
 *
 * **A link is acted on only when it is one-to-one both ways.** A LID seen with
 * two numbers (a number re-registered, say) or a number seen with two LIDs is
 * dropped from every use — merging, `phoneNumber`, scope messages — rather than
 * guessed between. Measured on a production account: none.
 *
 * Nothing here decides scope. A link says two ids are one person; whether a
 * token may read either is still `mcp-scope.ts`, over literal JIDs.
 */
export interface LidLinks {
  /** LID JID → its phone-number JID. */
  pnOf: ReadonlyMap<string, string>
  /** Phone-number JID → its LID JID. */
  lidOf: ReadonlyMap<string, string>
  /** LID chats on this account with no accepted link. */
  unlinkedLids: number
  /**
   * The links were actually read. False when the read failed and nothing was
   * cached, or when the connection has no message database to read them from —
   * the caller says "could not check" rather than "not linked".
   */
  available: boolean
}

const LID = /^\d+@lid$/
const PHONE = /^\d+@s\.whatsapp\.net$/

const NO_LINKS: LidLinks = { pnOf: new Map(), lidOf: new Map(), unlinkedLids: 0, available: false }

/**
 * Five minutes: links appear only when live traffic carries one, and a chat that
 * shows up merged a few minutes late costs nothing. Every surface — listing,
 * reading, searching, the picker — reads through this one cache, so within a
 * snapshot they all agree on who is linked.
 */
const resolveLinks = staleWhileFailing<LidLinks>({
  ttlMs: 5 * 60_000,
  retryTtlMs: 60_000,
  empty: NO_LINKS,
})

/**
 * This account's accepted links. Never throws: a failed read serves the last
 * good answer, or `available: false` when there is none.
 */
export async function lidLinks(instance: AppInstance): Promise<LidLinks> {
  // Without a message database there is nothing to read the links from, and the
  // listing falls back to `findChats`, which knows nothing about them either.
  if (!canReadMessages(instance)) return NO_LINKS

  return await resolveLinks(instance.id, async () => {
    try {
      return shapeLinks(await readLidLinks(instance))
    }
    catch (error) {
      console.error(`[identity] could not read LID links for connection ${instance.id}:`, error)
      return undefined
    }
  })
}

function shapeLinks(rows: LidLinkRow[]): LidLinks {
  const lidChats = new Set<string>()
  const numbersOfLid = new Map<string, Set<string>>()
  const lidsOfNumber = new Map<string, Set<string>>()

  const note = (lid: string, pn: string) => {
    numbersOfLid.set(lid, (numbersOfLid.get(lid) ?? new Set()).add(pn))
    lidsOfNumber.set(pn, (lidsOfNumber.get(pn) ?? new Set()).add(lid))
  }

  // Only the LID side's rows count as evidence. A phone-number chat's row can
  // carry its LID as `remoteJidAlt` too (none did, measured), but a link taken
  // from there would show a token scoped to the LID chat a phone number read out
  // of a chat it is not scoped to. Keeping the evidence on the LID chat's own
  // rows is what lets `phoneNumber` follow that chat's scope and nothing else.
  for (const { jid, alt } of rows) {
    if (!LID.test(jid)) continue
    lidChats.add(jid)
    if (alt && PHONE.test(alt)) note(jid, alt)
  }

  const pnOf = new Map<string, string>()
  const lidOf = new Map<string, string>()
  let ambiguous = 0

  for (const [lid, numbers] of numbersOfLid) {
    const [pn] = numbers
    if (numbers.size !== 1 || lidsOfNumber.get(pn!)?.size !== 1) {
      ambiguous++
      continue
    }
    pnOf.set(lid, pn!)
    lidOf.set(pn!, lid)
  }

  // Counted, never named: the ids are personal data and a count is what an
  // operator needs to know the rule fired.
  if (ambiguous) console.warn(`[identity] ${ambiguous} LID link(s) left unlinked: seen with more than one counterpart`)

  let unlinkedLids = 0
  for (const lid of lidChats) if (!pnOf.has(lid)) unlinkedLids++

  return { pnOf, lidOf, unlinkedLids, available: true }
}

/** The other id of a linked person, or nothing. */
export function linkedJidOf(links: LidLinks, jid: string): string | undefined {
  return links.pnOf.get(jid) ?? links.lidOf.get(jid)
}

/**
 * The id a linked person is listed under: the LID. Unlinked ids, groups and
 * anything else come back unchanged.
 *
 * The LID because a send to it lands in the existing LID conversation (#114),
 * and because people move from phone-number to LID addressing, not back — on
 * every split pair measured, the phone-number chat ended before the LID one began.
 */
export function canonicalJid(links: LidLinks, jid: string): string {
  return links.lidOf.get(jid) ?? jid
}

/**
 * The bare phone number behind a LID chat, when WhatsApp revealed it. Digits as
 * stored, like `ChatSummary.number` — no formatting, which needs country rules
 * this app never applies locally.
 */
export function phoneNumberBehind(links: LidLinks, lid: string): string | undefined {
  return links.pnOf.get(lid)?.split('@')[0]
}
