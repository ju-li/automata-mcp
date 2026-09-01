import type { AppInstance } from './pocketbase'
import type { EvolutionClient } from './evolution'
import type { MentionDirectory } from './mentions'
import { applyMentions, authorName, meaningfulName, mentionDirectory, mentionedJidsOf } from './mentions'
import { listMessagesPage, senderOf } from './evolution-db'

/**
 * Reading conversations out of Evolution.
 *
 * Shared by the MCP tools and the UI's chat picker so both see the same shape
 * and the same caveats.
 */

export interface ChatSummary {
  jid: string
  name: string
  isGroup: boolean
  /** Bare phone number of a 1:1 chat. Groups do not have one. */
  number?: string
  /** Members in a group, and only when the group lookup actually ran. */
  participantCount?: number
  profilePicUrl?: string
  updatedAt?: string
  /**
   * When the last message in the chat was sent, ISO 8601.
   *
   * Preferred over `updatedAt`, which is the Chat row's mtime and so also moves
   * for a read receipt or an unread-count change. Absent if Evolution's chat row
   * carries no last message — fall back to `updatedAt` for display.
   */
  lastMessageAt?: string
  unreadCount: number
  lastMessagePreview?: string
}

export interface ChatMessage {
  id?: string
  fromMe: boolean
  author?: string
  timestamp?: string
  type?: string
  text?: string
}

export interface ChatQuery {
  /** Page size. */
  take?: number
  /** Rows to skip. Evolution maps this straight to SQL `OFFSET`. */
  skip?: number
}

/**
 * One page of the account's conversations.
 *
 * The envelope is here because the obvious completeness signal is a trap. The
 * dashboard's chat count is `_count.Chat` — rows in Evolution's `Chat` table —
 * while this listing is `DISTINCT ON (remoteJid)` over `"Message"`. History sync
 * writes a `Chat` row for every conversation the phone lists but persists only
 * the messages it actually delivered, so the listing is legitimately shorter and
 * no amount of paging closes the gap. Comparing the two announces a truncation
 * that is not there and offers a next page that comes back empty.
 */
export interface ChatPage {
  chats: ChatSummary[]
  /**
   * There may be another page behind this one.
   *
   * Derived from "the page came back full", never from a count — the same rule
   * `MessagePage.hasMore` follows, and here the only count within reach counts a
   * different population entirely.
   */
  hasMore: boolean
}

/**
 * Recent conversations, newest activity first.
 *
 * Evolution builds this listing from its own tables, which are seeded by the
 * history WhatsApp hands over at pairing and then kept current by live traffic.
 * An account paired before `syncFullHistory` was switched on has no seed and so
 * shows only conversations active since — which is one reason the UI also lets a
 * number be added by hand. Returning nothing is never an error.
 *
 * The listing alone cannot name a chat (see `EvolutionChatRow`), so names are
 * enriched from Evolution's contact table and, when a group would otherwise
 * render as a raw id, from its group listing. **That enrichment is the cost of a
 * page, not of a row:** `fetchContacts` pulls Evolution's entire contact table
 * every call, because the endpoint filters to one JID and not to a set. Paging in
 * small increments therefore costs far more than one large page — prefer raising
 * `take` over walking `skip`.
 *
 * 2.3.7 maps `take` to `LIMIT` and `skip` to `OFFSET` on the raw query behind
 * `findChats`, and its route validator passes both through. The order is
 * `updatedAt DESC`, which live traffic reshuffles, so a caller accumulating pages
 * has to dedupe by JID rather than trust the offsets to be disjoint.
 */
export async function listChats(instance: AppInstance, query: ChatQuery = {}): Promise<ChatPage> {
  const evolution = evolutionClientForInstance(instance)

  const { take = 200, skip = 0 } = query

  const rows = await evolution<EvolutionChatRow[]>(
    `/chat/findChats/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { take, skip } },
  ).catch((error) => {
    // The first page must not break the picker or the MCP tool when Evolution is
    // down — an empty list is already the honest answer for a freshly paired
    // account. A later page was asked for by a deliberate click, and swallowing
    // that failure would render as the end of the list instead.
    if (skip > 0) throw error
    return [] as EvolutionChatRow[]
  })

  if (!Array.isArray(rows)) return { chats: [], hasMore: false }

  // Counted before the filter below: a row dropped for want of a JID must not be
  // able to report a full page as the end of the listing.
  const hasMore = rows.length >= take

  const drafts = rows
    .filter(row => typeof row?.remoteJid === 'string')
    .map((row) => {
      const jid = row.remoteJid!
      const localPart = jid.split('@')[0]!
      return {
        jid,
        localPart,
        isGroup: jid.endsWith('@g.us'),
        chatName: meaningfulName(row.pushName, localPart),
        profilePicUrl: row.profilePicUrl ?? undefined,
        updatedAt: row.updatedAt ?? undefined,
        lastMessageAt: isoFromEpochSeconds(row.lastMessage?.messageTimestamp),
        unreadCount: Number(row.unreadCount ?? 0),
        lastMessagePreview: previewOf(row.lastMessage?.message),
      }
    })

  // Only pay for the group listing when it can change an answer — every group
  // that the chat rows alone already name is a round trip per group we skip.
  const needsGroups = drafts.some(draft => draft.isGroup && !draft.chatName)

  const [contacts, groups] = await Promise.all([
    contactDirectory(instance, evolution),
    needsGroups ? fetchGroups(instance, evolution) : Promise.resolve(emptyGroups),
  ])

  const chats = drafts.map((draft) => {
    const contact = contacts.get(draft.jid)
    const group = groups.get(draft.jid)

    // A group's subject is authoritative; for a person the saved contact name is
    // what they expect to read. Everything falls through to the bare id, which is
    // still a truthful label — just not a helpful one.
    const name = draft.isGroup
      ? group?.subject ?? draft.chatName ?? contact?.name ?? draft.localPart
      : contact?.name ?? draft.chatName ?? draft.localPart

    return {
      jid: draft.jid,
      name,
      isGroup: draft.isGroup,
      number: draft.isGroup ? undefined : draft.localPart,
      participantCount: group?.size,
      profilePicUrl: draft.profilePicUrl ?? contact?.profilePicUrl ?? group?.pictureUrl,
      updatedAt: draft.updatedAt,
      lastMessageAt: draft.lastMessageAt,
      unreadCount: draft.unreadCount,
      lastMessagePreview: draft.lastMessagePreview,
    }
  })

  return { chats, hasMore }
}

export interface MessageQuery {
  /** Page size. Evolution calls this `offset`, confusingly. */
  limit?: number
  /** 1-based. Paging is how you reach anything older than `limit` messages. */
  page?: number
  /** Inclusive lower bound, ISO 8601. */
  since?: string
  /** Inclusive upper bound, ISO 8601. */
  until?: string
  /**
   * Keep reaction messages in the result.
   *
   * Defaults to true, which is what this helper has always done — nothing
   * changes without an explicit argument. The MCP tool is the thing that opts
   * out; see `read-messages`.
   */
  includeReactions?: boolean
}

/**
 * One page of a chat's history.
 *
 * The envelope matters as much as the rows. Evolution answers newest-first and
 * caps the response at the page size, so truncating a `since`-bounded window
 * drops the *old* end — precisely the part a caller who named a date range asked
 * for, while keeping the part they would have got without asking. A page that
 * does not say it is a page reads as a complete answer, and a summary written
 * from it has a hole in it. `searchMessages` in `evolution-db.ts` carries a
 * `truncated` flag for the same reason.
 */
export interface MessagePage {
  messages: ChatMessage[]
  /**
   * There may be another page behind this one.
   *
   * Derived from "the page came back full", never from `total`: a count that is
   * wrong upstream must not be able to drive a caller into paging forever. Being
   * wrong this way is wrong in the safe direction — an exactly-full final page
   * costs one extra call that returns nothing, and a page with more behind it is
   * never reported as complete.
   */
  hasMore: boolean
  /**
   * Distinct messages in the range, counted over the same deduplicated set the
   * page was cut from — so it counts the range asked for, not the chat, and not
   * the rows Evolution happens to hold for it.
   *
   * Reported as a number, never as a decision: `hasMore` does not read it. Absent
   * for a page past the end of the range, where there was nothing to count from.
   */
  total?: number
}

/**
 * Message history for one chat, newest first.
 *
 * Reads Evolution's database rather than its API, which is not a preference: one
 * message is stored two or three times over a re-pair, and only SQL can collapse
 * those before the page is cut. `listMessagesPage` in `evolution-db.ts` explains
 * the duplicates and what the query does about them.
 *
 * What is left here is the shaping: a payload becomes a line of text, a sender
 * becomes a name. Both need the same name directory, so it is built once and used
 * for the authors and the @-mentions alike.
 *
 * There is no text search on this path — `searchMessages` is that — and no
 * `where` to widen: the range bounds are ordinary SQL predicates, so a one-sided
 * range means one predicate, and `read-messages` pins its own `until` only so
 * that paging a window is repeatable, not because a missing bound is ignored.
 */
export async function listMessages(
  instance: AppInstance,
  remoteJid: string,
  query: MessageQuery = {},
): Promise<MessagePage> {
  const { limit = 50, page = 1, since, until, includeReactions = true } = query

  const { records, hasMore, total } = await listMessagesPage(instance, {
    jid: remoteJid,
    limit,
    page,
    since,
    until,
    includeReactions,
  })

  const drafts = records.map(row => ({
    id: row.key?.id,
    fromMe: Boolean(row.key?.fromMe),
    sender: senderOf(row),
    timestamp: isoFromEpochSeconds(row.messageTimestamp),
    type: row.messageType ?? undefined,
    text: previewOf(row.message),
    mentioned: mentionedJidsOf(row.mentioned),
  }))

  const directory = await nameDirectory(instance, remoteJid, drafts)

  return {
    messages: drafts.map(draft => ({
      id: draft.id,
      fromMe: draft.fromMe,
      author: authorName({ fromMe: draft.fromMe, ...draft.sender }, directory),
      timestamp: draft.timestamp,
      type: draft.type,
      text: directory ? applyMentions(draft.text, draft.mentioned, directory) : draft.text,
    })),
    hasMore,
    total,
  }
}

/**
 * Names for everyone a page refers to — senders and mentions together.
 *
 * One chat means one participant lookup, so unlike `search-messages` there is
 * nothing to ration here. It is skipped entirely when the page needs no names at
 * all: a 1:1 chat of your own messages resolves nobody.
 *
 * Best effort by design. Group membership needs a live socket, so a disconnected
 * account resolves nothing — and must still return its messages, with authors
 * falling back to whatever `pushName` was stored.
 */
async function nameDirectory(
  instance: AppInstance,
  remoteJid: string,
  drafts: Array<{ fromMe: boolean, sender: { identity?: string }, mentioned: string[] }>,
): Promise<MentionDirectory | undefined> {
  const needed = drafts.some(draft => draft.mentioned.length || (!draft.fromMe && draft.sender.identity))
  if (!needed) return undefined

  try {
    const evolution = evolutionClientForInstance(instance)
    const contacts = await contactDirectory(instance, evolution)
    return await mentionDirectory({ instance, evolution, chatJids: [remoteJid], contacts })
  }
  catch (error) {
    console.error('[read] could not resolve names:', error)
    return undefined
  }
}

// ── naming ─────────────────────────────────────────────────────────────────

/**
 * `fetchContacts`, memoised per account.
 *
 * The endpoint has no JID-list filter, so naming anything costs the whole contact
 * table — and it was previously paid again on every `listChats` call, i.e. once
 * per page while walking `skip`, plus once more for every mention lookup. Contact
 * names change on a human timescale, so a short TTL removes almost all of that
 * without anyone noticing a stale name.
 *
 * Failures are deliberately **not** cached here: unlike the group and participant
 * lookups this is a plain database read on Evolution's side that answers even
 * while the account is disconnected, so a failure is a real fault worth retrying
 * rather than an expected offline state to back off from.
 */
const CONTACT_CACHE_TTL_MS = 5 * 60_000
const contactCache = new Map<string, { expiresAt: number, contacts: Map<string, ContactInfo> }>()
const contactFetches = new Map<string, Promise<Map<string, ContactInfo>>>()

export async function contactDirectory(
  instance: AppInstance,
  evolution: EvolutionClient,
): Promise<Map<string, ContactInfo>> {
  const cached = contactCache.get(instance.id)
  if (cached && Date.now() < cached.expiresAt) return cached.contacts

  // Concurrent callers share one fetch, as `pocketbaseAdmin()` does. A search
  // labels its chats and resolves its mentions at the same time, so a cold cache
  // would otherwise pull the entire contact table twice for one request.
  const inFlight = contactFetches.get(instance.id)
  if (inFlight) return inFlight

  const fetching = fetchContacts(instance, evolution)
    .then((contacts) => {
      if (contacts.size) {
        contactCache.set(instance.id, { expiresAt: Date.now() + CONTACT_CACHE_TTL_MS, contacts })
      }
      return contacts
    })
    .finally(() => contactFetches.delete(instance.id))

  contactFetches.set(instance.id, fetching)
  return fetching
}

/**
 * Evolution's contact table, keyed by JID.
 *
 * Cheap: a plain database read on Evolution's side, so it answers even while the
 * account is disconnected. Its `pushName` is `contact.name || verifiedName ||
 * <bare number>` — the saved address-book name whenever there is one, which is
 * what a person expects to read.
 *
 * There is no way to filter this to a set of JIDs (the endpoint's `where` takes
 * one `remoteJid`, not a list), so it returns the whole table and we index it.
 */
async function fetchContacts(instance: AppInstance, evolution: EvolutionClient): Promise<Map<string, ContactInfo>> {
  const byJid = new Map<string, ContactInfo>()

  const rows = await evolution<EvolutionContactRow[]>(
    `/chat/findContacts/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: {} },
  ).catch(() => [] as EvolutionContactRow[])

  if (!Array.isArray(rows)) return byJid

  for (const row of rows) {
    if (typeof row?.remoteJid !== 'string') continue
    byJid.set(row.remoteJid, {
      name: meaningfulName(row.pushName, row.remoteJid.split('@')[0]!),
      profilePicUrl: row.profilePicUrl ?? undefined,
    })
  }

  return byJid
}

/**
 * Group subjects, keyed by group JID.
 *
 * **This one is expensive.** Evolution answers it from Baileys rather than its
 * database, and fetches a profile picture — an uncached round trip to WhatsApp —
 * for every group, sequentially. An account in thirty groups pays thirty round
 * trips. Hence the caller only asks when a group would otherwise show a raw id,
 * and hence the two guards here:
 *
 *   timeout  a picker that renders ids is better than a modal that hangs. The
 *            account may simply be disconnected, in which case this never returns.
 *   cache    the only in-process cache in this app, and deliberate. Subjects
 *            change rarely, while the picker refetches on every dialog open and
 *            an MCP client may call list-chats repeatedly. A stale map is served
 *            if a later refresh fails, because a name we had a moment ago still
 *            beats a raw id.
 *
 * A failure is cached too, for a shorter window. `findChats` reads Evolution's
 * database and so still returns rows while the account is disconnected — exactly
 * when this call cannot succeed — and without that window every picker open
 * would pay the timeout again.
 */
const GROUP_CACHE_TTL_MS = 5 * 60_000
const GROUP_RETRY_TTL_MS = 60_000
const GROUP_TIMEOUT_MS = 8_000
const groupCache = new Map<string, { expiresAt: number, groups: Map<string, GroupInfo> }>()
const emptyGroups: Map<string, GroupInfo> = new Map()

async function fetchGroups(instance: AppInstance, evolution: EvolutionClient): Promise<Map<string, GroupInfo>> {
  const cached = groupCache.get(instance.id)
  if (cached && Date.now() < cached.expiresAt) return cached.groups

  // `getParticipants` is required — Evolution answers 400 without it.
  const rows = await evolution<EvolutionGroupRow[]>(
    `/group/fetchAllGroups/${encodeURIComponent(instance.name)}?getParticipants=false`,
    { timeout: GROUP_TIMEOUT_MS },
  ).catch(() => undefined)

  if (!Array.isArray(rows)) {
    const groups = cached?.groups ?? emptyGroups
    groupCache.set(instance.id, { expiresAt: Date.now() + GROUP_RETRY_TTL_MS, groups })
    return groups
  }

  const byJid = new Map<string, GroupInfo>()
  for (const row of rows) {
    if (typeof row?.id !== 'string') continue
    byJid.set(row.id, {
      subject: row.subject?.trim() || undefined,
      size: typeof row.size === 'number' ? row.size : undefined,
      pictureUrl: row.pictureUrl ?? undefined,
    })
  }

  groupCache.set(instance.id, { expiresAt: Date.now() + GROUP_CACHE_TTL_MS, groups: byJid })
  return byJid
}

// ── internals ──────────────────────────────────────────────────────────────

/**
 * What `POST /chat/findChats` actually returns.
 *
 * `pushName` is **not** the sender's push name, despite the key. Evolution 2.3.7
 * builds this row with a raw query that aliases two different columns as
 * `pushName` — a CASE over the contact and message names, and then `Chat.name` —
 * and the second silently wins when the row is deserialised. `Chat.name` is only
 * written from an inbound 1:1 message, and never for a group, so it is empty for
 * most rows. That upstream bug is why names are enriched above rather than read
 * from here.
 */
interface EvolutionChatRow {
  remoteJid?: string
  pushName?: string
  profilePicUrl?: string
  updatedAt?: string
  unreadCount?: number
  lastMessage?: { message?: unknown, messageTimestamp?: number | string }
}

interface EvolutionContactRow {
  remoteJid?: string
  pushName?: string
  profilePicUrl?: string
}

interface EvolutionGroupRow {
  id?: string
  subject?: string
  size?: number
  pictureUrl?: string
}

interface ContactInfo {
  name?: string
  profilePicUrl?: string
}

interface GroupInfo {
  subject?: string
  size?: number
  pictureUrl?: string
}

/**
 * WhatsApp timestamps are epoch **seconds**, and arrive as a number or a string
 * depending on where in Evolution's response they sit. Returns undefined rather
 * than an "Invalid Date" for anything that does not parse — the callers all treat
 * a missing timestamp as a thing to render as a dash, not as an error.
 */
function isoFromEpochSeconds(value: number | string | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds * 1000).toISOString()
}

/**
 * WhatsApp message payloads are a union of a few dozen shapes. Pull out the text
 * ones and describe the rest rather than dumping raw protobuf JSON at the model.
 */
function previewOf(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const m = message as Record<string, any>

  if (typeof m.conversation === 'string') return m.conversation
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text
  if (typeof m.imageMessage?.caption === 'string') return `[image] ${m.imageMessage.caption}`
  if (m.imageMessage) return '[image]'
  if (m.videoMessage) return '[video]'
  if (m.audioMessage) return '[voice message]'
  if (m.documentMessage) return `[document] ${m.documentMessage.fileName ?? ''}`.trim()
  if (m.stickerMessage) return '[sticker]'
  if (typeof m.reactionMessage?.text === 'string') return `[reaction] ${m.reactionMessage.text}`

  return undefined
}
