import type { AppInstance } from './app-db'
import type { EvolutionClient } from './evolution'
import type { SenderNameLookup } from './sender-names'

/**
 * Turning `@79972425314508` in a message body into `@Ju`.
 *
 * WhatsApp writes a mention as the bare local part of the mentioned JID, and in a
 * group that JID is usually a **LID** (`@lid`) — a per-user identity that is not a
 * phone number and carries no country code. Left as-is it reads as an opaque
 * number, and a model summarising the thread has to guess who was addressed. That
 * guess is the bug: it produces confident misattribution.
 *
 * Two rules keep the substitution honest.
 *
 * Replacement is driven off `contextInfo.mentionedJid` — the list WhatsApp itself
 * marked as mentions — never off a `@\d+` scan of the text. A number that merely
 * looks like a mention (an order id, a price, a phone number someone typed) is
 * therefore never rewritten.
 *
 * And a name that is only the number again is not a name. Evolution falls back to
 * the bare local part whenever it has nothing better, so `meaningfulName` drops
 * that case and the mention stays raw rather than being "resolved" to itself.
 *
 * Everything here is best-effort. The participant lookup needs a live socket, so
 * a disconnected account resolves nothing — and must still return its messages.
 */

/** Everything before the `@`. `79972425314508@lid` → `79972425314508`. */
export function localPartOf(jid: string): string {
  return jid.split('@')[0] ?? ''
}

/**
 * A name worth showing, or nothing.
 *
 * Evolution falls back to the bare number when it has no real name — in
 * `Contact.pushName` and on a chat row alike — so a "name" equal to the JID's
 * local part carries no information. Returning undefined lets the next candidate
 * be tried instead of ending the search on a number dressed up as a name.
 */
export function meaningfulName(value: string | undefined | null, localPart: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === localPart) return undefined
  return trimmed
}

/**
 * The JIDs a message mentions.
 *
 * Accepts either Evolution's whole `contextInfo` object (the HTTP path returns the
 * column as-is) or an already-extracted `mentionedJid` array (the SQL path selects
 * just that key). Anything else is no mentions, not an error — this sits on a read
 * path that must keep working against a payload shape we did not predict.
 */
export function mentionedJidsOf(source: unknown): string[] {
  const raw = Array.isArray(source)
    ? source
    : source && typeof source === 'object'
      ? (source as Record<string, unknown>).mentionedJid
      : undefined

  if (!Array.isArray(raw)) return []
  return raw.filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
}

/** Local part → display name. Keyed on the local part because that is all the message text carries. */
export type MentionDirectory = Map<string, string>

/**
 * Names for the people a set of messages mentions.
 *
 * Keyed on the local part so a LID and a phone JID for the same person land on the
 * same entry — which also means the caller does not have to know which form this
 * deployment stores, and a tag bump that changes it does not break the lookup.
 *
 * Contacts first, then group participants over the top — see `addGroupMembers`
 * for why that order and not the other. A caller that needs to inspect the
 * contacts pass before paying for the group pass composes the two halves itself
 * rather than calling this twice.
 */
export async function mentionDirectory(options: {
  instance: AppInstance
  evolution: EvolutionClient
  /** Chats whose membership to look up. Non-group JIDs are ignored. */
  chatJids: Iterable<string>
  /** Contact map from `contactDirectory()`, keyed by JID. Optional. */
  contacts?: Map<string, { name?: string }>
  /** Identities the caller needs names for; see `addGroupMembers`. */
  needed?: Iterable<string>
  /** Names senders gave themselves on live rows; see `addSenderNames`. */
  senderNames?: SenderNameLookup
}): Promise<MentionDirectory> {
  return await addGroupMembers(contactsToDirectory(options.contacts), options)
}

/**
 * The contacts half, on its own.
 *
 * Separate from `addGroupMembers` because `search-messages` needs the two in
 * stages: it has to see what contacts already resolved before it can decide
 * which groups are worth a round trip. It used to get that by calling
 * `mentionDirectory` twice — once with no chats, then again with the groups —
 * which walked the entire contact table a second time and threw the first
 * result away. On an account with a large address book that was the more
 * expensive half of the call.
 */
export function contactsToDirectory(contacts?: Map<string, { name?: string }>): MentionDirectory {
  const directory: MentionDirectory = new Map()

  for (const [jid, info] of contacts ?? []) {
    const localPart = localPartOf(jid)
    const name = meaningfulName(info.name, localPart)
    if (localPart && name) directory.set(localPart, name)
  }

  return directory
}

/**
 * The group half: adds every named participant, **overwriting** contacts, then
 * names the unnamed ones through the contacts they are linked to.
 *
 * That precedence is the reason this runs second and not first. Evolution's
 * `Contact` table is written from inbound traffic keyed on `key.remoteJid`,
 * which for a group message is the *group's* JID, so it is a good source for
 * 1:1 chats and a poor one for group members. Participant metadata comes from
 * the group itself and is the authority on who is in it.
 *
 * **Most participants arrive unnamed (#279).** Baileys' group metadata carries
 * no name at all, only identities; Evolution's `findParticipants` adds one from
 * the `Contact` row whose `remoteJid` equals the participant's `id` — which in a
 * LID-addressed group is the LID, while the account's contacts are mostly keyed
 * by phone JID. What the row *does* carry is the pairing: `id` (LID) beside
 * `phoneNumber` (rc14), or `id` beside `jid`/`lid` (rc.9). So an unnamed
 * participant takes the name any of its identities already has in the
 * directory, and that name is then indexed under the others — which is what
 * lets a history-imported row, whose only identity is the sender's LID digits,
 * reach the phone-keyed contact. Gaps only: an identity that already has a
 * name keeps it. Display-only, like the rest of the directory; no JID is built.
 *
 * Mutates and returns the directory it was given, so a caller can build the
 * contacts once and add to it.
 *
 * `needed`, when given, names the identities the caller is about to look up.
 * Those still unnamed after the participants take a name from `senderNames`
 * last (`addSenderNames`, #321) — also when there is no group to look up. A
 * group read for which none of them resolves is logged (once per connection
 * per few minutes) with the reason, since every hop here degrades silently —
 * the state #279 sat in unnoticed.
 */
export async function addGroupMembers(
  directory: MentionDirectory,
  options: {
    instance: AppInstance
    evolution: EvolutionClient
    /** Chats whose membership to look up. Non-group JIDs are ignored. */
    chatJids: Iterable<string>
    /** Identities (JIDs or local parts) the caller needs names for: diagnostics, and the gaps `senderNames` fills. */
    needed?: Iterable<string>
    /** Names senders gave themselves on live rows; see `addSenderNames`. */
    senderNames?: SenderNameLookup
  },
): Promise<MentionDirectory> {
  // Read twice below; an iterable may not survive the first pass.
  const needed = options.needed ? [...options.needed] : undefined
  const groupJids = [...new Set(options.chatJids)].filter(jid => jid.endsWith('@g.us'))
  if (!groupJids.length) {
    addSenderNames(directory, options.senderNames, needed ?? [])
    return directory
  }

  const memberships = await Promise.all(
    groupJids.map(jid => fetchParticipants(options.instance, options.evolution, jid)),
  )

  // Named first, across every group, so an unnamed participant in one group
  // can borrow the name WhatsApp reported for the same person in another.
  for (const { members } of memberships) {
    for (const member of members) {
      if (!member.name) continue
      for (const localPart of member.identities) directory.set(localPart, member.name)
    }
  }

  let linked = 0
  for (const { members } of memberships) {
    for (const member of members) {
      if (member.name) continue
      // A contact saved under its own number is a number, not a name; carried
      // onto a LID it would show that person's phone number as their name.
      const name = member.identities
        .map(localPart => directory.get(localPart))
        .find(candidate => candidate && !looksLikeIdentifier(candidate))
      if (!name) continue
      linked++
      for (const localPart of member.identities) {
        if (!directory.has(localPart)) directory.set(localPart, name)
      }
    }
  }

  // Last, so it fills only what contacts and participants left unnamed.
  addSenderNames(directory, options.senderNames, needed ?? [])

  if (needed) reportUnresolved(options.instance, directory, needed, memberships, linked, options.senderNames !== undefined)

  return directory
}

/**
 * Names the still-unnamed `needed` identities from what each sender called
 * themselves on their own live messages (`sender-names.ts`, #321): the
 * "~ Name" WhatsApp shows for someone who is not a saved contact. That is what
 * names a sender of imported history, whose row carries only LID digits, when
 * neither the address book nor the group's participant list does.
 *
 * **Gaps only, lowest precedence.** Runs after contacts and participants, and
 * never replaces a name they gave: a push name is the sender's own choice and
 * changes on a whim, while a contact name is what the account owner chose.
 * The lookup already refused numbers and JIDs dressed as names. Only `…@lid`
 * identities are looked up: the map is keyed by LID digits, and a phone
 * number's digits are not one.
 */
export function addSenderNames(
  directory: MentionDirectory,
  senderNames: SenderNameLookup | undefined,
  needed: Iterable<string>,
): void {
  if (!senderNames) return
  for (const identity of needed) {
    // The map is keyed by LID; a phone JID's digits are a different namespace.
    if (!identity.endsWith('@lid')) continue
    const localPart = localPartOf(identity)
    // The map, and the other sources, key without a device suffix (`123:4` → `123`).
    const bare = localPart.split(':')[0]!
    if (!bare || directory.has(localPart) || directory.has(bare)) continue
    const name = senderNames(bare)
    if (!name) continue
    directory.set(localPart, name)
  }
}

/**
 * The log line #279 asked for: a group read needed names and got none.
 *
 * Counts only — never a name, a JID or a group id — and at most once per
 * connection per `UNRESOLVED_LOG_INTERVAL_MS`, since a model paging through a
 * group would otherwise write it on every page. The reason is the first hop
 * that came back with nothing: the lookup failed, answered no participants,
 * answered participants carrying no identity we index, or answered named and
 * linkable participants that simply are not the senders on this page (people
 * who have left, or history older than the group's current membership). None
 * of the senders named themselves on a live message either; `sender names`
 * says whether that map (#321) had been built yet.
 */
const UNRESOLVED_LOG_INTERVAL_MS = 5 * 60_000
const unresolvedLoggedAt = new Map<string, number>()

function reportUnresolved(
  instance: AppInstance,
  directory: MentionDirectory,
  needed: Iterable<string>,
  memberships: Membership[],
  linked: number,
  senderNamesLoaded: boolean,
): void {
  const wanted = new Set([...needed].map(localPartOf).filter(Boolean))
  if (!wanted.size) return
  for (const localPart of wanted) if (directory.has(localPart)) return

  const now = Date.now()
  const last = unresolvedLoggedAt.get(instance.id)
  if (last !== undefined && now - last < UNRESOLVED_LOG_INTERVAL_MS) return
  unresolvedLoggedAt.set(instance.id, now)
  // Bounded by connections in this process; prune the expired on the way.
  for (const [id, at] of unresolvedLoggedAt) {
    if (now - at >= UNRESOLVED_LOG_INTERVAL_MS) unresolvedLoggedAt.delete(id)
  }

  const failed = memberships.filter(m => m.failed).length
  const answered = memberships.filter(m => !m.failed)
  const rows = answered.reduce((sum, m) => sum + m.rows, 0)
  const members = answered.reduce((sum, m) => sum + m.members.length, 0)
  const named = answered.reduce((sum, m) => sum + m.members.filter(member => member.name).length, 0)

  const reason = failed === memberships.length
    ? 'participant lookup failed'
    : rows === 0
      ? 'participant lookup answered no participants'
      : members === 0
        ? 'participants carry no identity we index'
        : named + linked === 0
          ? 'no participant named by WhatsApp or linked to a contact, and no sender named on a live message'
          : 'senders are not among the named participants, and none named on a live message'

  console.warn(
    `[names] ${instance.id}: group read resolved none of ${wanted.size} identities (${reason}; `
    + `groups ${memberships.length}, lookups failed ${failed}, participants ${rows}, `
    + `with identity ${members}, named by WhatsApp ${named}, named via contact ${linked}, `
    + `sender names ${senderNamesLoaded ? 'loaded' : 'not loaded'}, directory ${directory.size})`,
  )
}

/**
 * Rewrite a message body so mentions read as names.
 *
 * One pass over the text, alternating on every resolved local part at once, so a
 * substituted name can never itself be rewritten by a later mention. Longest key
 * first and a `(?!\d)` guard together stop `@123` from eating the front of
 * `@1234` — without it a short LID would silently corrupt a longer one.
 *
 * Anything unresolved is left exactly as it was: a raw id is honest, a wrong name
 * is the failure this whole module exists to prevent.
 */
export function applyMentions(
  text: string | undefined,
  jids: string[],
  directory: MentionDirectory,
): string | undefined {
  if (!text || !jids.length || !directory.size) return text

  const localParts = [...new Set(jids.map(localPartOf))]
    .filter(localPart => localPart && directory.has(localPart))
    .sort((a, b) => b.length - a.length)

  if (!localParts.length) return text

  const pattern = new RegExp(`@(${localParts.map(escapeRegExp).join('|')})(?!\\d)`, 'g')
  return text.replace(pattern, (whole, localPart: string) => {
    const name = directory.get(localPart)
    return name ? `@${name}` : whole
  })
}

// ── participants ───────────────────────────────────────────────────────────

/**
 * Group membership: one entry per participant, with every identity it carries
 * and its name where Evolution had one.
 *
 * Cached through `staleWhileFailing`, which explains the three behaviours it
 * buys: Evolution answers this from Baileys rather than its database, so it is a
 * live round trip that never returns while the account is disconnected. Awaited,
 * unlike the group listing in `chats.ts` (`staleWhileRevalidate`), because it is
 * one group's members rather than every group's picture, and a read needs the
 * answer to name its authors.
 *
 * A participant is indexed under every identity it carries — `id`, `lid`,
 * `phoneNumber`, `jid` — because which one appears in `mentionedJid` depends on
 * the chat's addressing mode, which is WhatsApp's choice and not ours. Unnamed
 * participants are **kept**, not skipped: their identities are the link from a
 * LID to the phone-keyed contact that names it (`addGroupMembers`, #279).
 */
const PARTICIPANT_TIMEOUT_MS = 8_000

interface GroupMember {
  /** Local parts, deduplicated. Never empty. */
  identities: string[]
  name?: string
}

interface Membership {
  members: readonly GroupMember[]
  /** Participant rows Evolution answered with, including ones with no identity we index. */
  rows: number
  /** Set only on the shared answer for "lookup failed and nothing was cached". */
  failed?: true
}

const failedMembership: Membership = Object.freeze({ members: Object.freeze([]), rows: 0, failed: true as const })

const participantCache = staleWhileFailing<Membership>({
  ttlMs: 5 * 60_000,
  retryTtlMs: 60_000,
  empty: failedMembership,
})

async function fetchParticipants(
  instance: AppInstance,
  evolution: EvolutionClient,
  groupJid: string,
): Promise<Membership> {
  return participantCache(`${instance.id}:${groupJid}`, async () => {
    const result = await evolution<EvolutionParticipantsResponse | EvolutionParticipantRow[]>(
      `/group/participants/${encodeURIComponent(instance.name)}?groupJid=${encodeURIComponent(groupJid)}`,
      { timeout: PARTICIPANT_TIMEOUT_MS },
    ).catch(() => undefined)

    const rows = Array.isArray(result) ? result : result?.participants

    // Reported as a failure, so the cache serves whatever it had — see
    // `staleWhileFailing`. A group whose members simply have no readable names
    // answers with unnamed members instead, and is cached for the full window.
    if (!Array.isArray(rows)) return undefined

    const members: GroupMember[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue

      const identities = [...new Set(
        [row.id, row.lid, row.phoneNumber, row.jid]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .map(localPartOf)
          .filter(Boolean),
      )]

      if (!identities.length) continue

      // Same rule as `meaningfulName`, widened to every identity the row carries: a
      // participant labelled with any of its own ids has no name, not a numeric one.
      // Typed loosely because Evolution passes Baileys' fields through untyped.
      const name = [row.name, row.notify, row.pushName, row.verifiedName]
        .map(candidate => typeof candidate === 'string' ? candidate.trim() : undefined)
        .find(candidate => candidate && !identities.includes(candidate) && !looksLikeIdentifier(candidate))

      members.push(name ? { identities, name } : { identities })
    }

    return { members, rows: rows.length }
  })
}

/**
 * What `GET /group/participants` answers with.
 *
 * Every field is optional on purpose. Evolution builds this from Baileys' group
 * metadata joined against its own `Contact` table, and which identity fields come
 * back varies with the Baileys version and the chat's addressing mode. Reading it
 * defensively is what lets the resolver degrade to "no name" instead of throwing.
 */
interface EvolutionParticipantRow {
  id?: string
  jid?: string
  lid?: string
  phoneNumber?: string
  name?: string
  notify?: string
  pushName?: string
  verifiedName?: string
}

interface EvolutionParticipantsResponse {
  participants?: EvolutionParticipantRow[]
}

/** A name is data, not a pattern — it reaches the regex as a literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── authors ────────────────────────────────────────────────────────────────

/**
 * Who sent a message, as a name a person would recognise — or nothing.
 *
 * `pushName` alone cannot answer this. It is whatever the sending device put on
 * the wire at the time, and Evolution stores it verbatim, so the same message can
 * carry a real name, a bare LID (`79963868897335`), a full LID JID
 * (`79963868897335@lid`), or the sender's own device-locale word for themselves —
 * `"Você"` on a Portuguese phone. Two rows for one message written by two
 * different history imports routinely disagree, which is how the same sender
 * appeared under three names in one conversation.
 *
 * So the sender's identity is resolved through the directory first, exactly as a
 * mention is, and `pushName` is only a fallback. Anything that is a number or a
 * JID rather than a name is refused outright: a raw id in an `author` field reads
 * as a name and gets quoted as one.
 *
 * **A message you sent has no author at all.** `fromMe` already says so, in a
 * field that cannot disagree with itself, and the alternative is the localised
 * self-label — which is both noise and, next to the account's real name on the
 * very same message, a contradiction.
 */
export function authorName(
  sender: { fromMe: boolean, identity?: string, pushName?: string | null },
  directory?: MentionDirectory,
): string | undefined {
  if (sender.fromMe) return undefined

  const localPart = sender.identity ? localPartOf(sender.identity) : undefined

  const known = localPart ? directory?.get(localPart) : undefined
  if (known) return known

  const pushName = sender.pushName?.trim()
  if (!pushName || looksLikeIdentifier(pushName)) return undefined

  return localPart ? meaningfulName(pushName, localPart) : pushName
}

/**
 * A number, or a JID, dressed up as a name.
 *
 * `meaningfulName` only catches the case where the "name" equals the local part
 * it was going to be shown against, which needs an identity to compare with — and
 * a history-sync row often has none. This catches the shape instead, so a bare
 * LID never reaches a caller as an author.
 */
export function looksLikeIdentifier(value: string): boolean {
  return /^[+\d][\d\s()+-]*$/.test(value) || value.includes('@')
}
