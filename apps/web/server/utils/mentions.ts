import type { AppInstance } from './pocketbase'
import type { EvolutionClient } from './evolution'

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
 * Group participants are fetched last because they outrank contacts. Evolution's
 * `Contact` table is written from inbound traffic keyed on `key.remoteJid`, which
 * for a group message is the *group's* JID, so it is a good source for 1:1 chats
 * and a poor one for group members. Participant metadata comes from the group
 * itself and is the authority on who is in it.
 */
export async function mentionDirectory(options: {
  instance: AppInstance
  evolution: EvolutionClient
  /** Chats whose membership to look up. Non-group JIDs are ignored. */
  chatJids: Iterable<string>
  /** Contact map from `contactDirectory()`, keyed by JID. Optional. */
  contacts?: Map<string, { name?: string }>
}): Promise<MentionDirectory> {
  const directory: MentionDirectory = new Map()

  for (const [jid, info] of options.contacts ?? []) {
    const localPart = localPartOf(jid)
    const name = meaningfulName(info.name, localPart)
    if (localPart && name) directory.set(localPart, name)
  }

  const groupJids = [...new Set(options.chatJids)].filter(jid => jid.endsWith('@g.us'))

  const memberships = await Promise.all(
    groupJids.map(jid => fetchParticipants(options.instance, options.evolution, jid)),
  )

  for (const members of memberships) {
    for (const [localPart, name] of members) directory.set(localPart, name)
  }

  return directory
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
 * Group membership, keyed by local part.
 *
 * Cached and guarded exactly like `fetchGroups` in `chats.ts`, and for the same
 * reasons: Evolution answers this from Baileys rather than its database, so it is
 * a live round trip that never returns while the account is disconnected. A
 * failure is cached for a shorter window so a disconnected account does not pay
 * the timeout on every single call.
 *
 * A participant is indexed under every identity it carries — `id`, `lid`,
 * `phoneNumber`, `jid` — because which one appears in `mentionedJid` depends on
 * the chat's addressing mode, which is WhatsApp's choice and not ours.
 */
const PARTICIPANT_CACHE_TTL_MS = 5 * 60_000
const PARTICIPANT_RETRY_TTL_MS = 60_000
const PARTICIPANT_TIMEOUT_MS = 8_000
const participantCache = new Map<string, { expiresAt: number, members: MentionDirectory }>()
const emptyMembers: MentionDirectory = new Map()

async function fetchParticipants(
  instance: AppInstance,
  evolution: EvolutionClient,
  groupJid: string,
): Promise<MentionDirectory> {
  const cacheKey = `${instance.id}:${groupJid}`
  const cached = participantCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.members

  const result = await evolution<EvolutionParticipantsResponse | EvolutionParticipantRow[]>(
    `/group/participants/${encodeURIComponent(instance.name)}?groupJid=${encodeURIComponent(groupJid)}`,
    { timeout: PARTICIPANT_TIMEOUT_MS },
  ).catch(() => undefined)

  const rows = Array.isArray(result) ? result : result?.participants

  if (!Array.isArray(rows)) {
    // A name we had a moment ago still beats a raw id, so a failed refresh serves
    // the stale map rather than dropping back to nothing.
    const members = cached?.members ?? emptyMembers
    participantCache.set(cacheKey, { expiresAt: Date.now() + PARTICIPANT_RETRY_TTL_MS, members })
    return members
  }

  const members: MentionDirectory = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue

    const identities = [row.id, row.lid, row.phoneNumber, row.jid]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map(localPartOf)
      .filter(Boolean)

    if (!identities.length) continue

    // Same rule as `meaningfulName`, widened to every identity the row carries: a
    // participant labelled with any of its own ids has no name, not a numeric one.
    const name = [row.name, row.notify, row.pushName, row.verifiedName]
      .map(candidate => candidate?.trim())
      .find(candidate => candidate && !identities.includes(candidate))

    if (!name) continue
    for (const localPart of identities) members.set(localPart, name)
  }

  participantCache.set(cacheKey, { expiresAt: Date.now() + PARTICIPANT_CACHE_TTL_MS, members })
  return members
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
function looksLikeIdentifier(value: string): boolean {
  return /^[+\d][\d\s()+-]*$/.test(value) || value.includes('@')
}
