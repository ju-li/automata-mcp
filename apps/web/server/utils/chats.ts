import type { AppInstance } from './pocketbase'
import type { EvolutionClient } from './evolution'

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
 * render as a raw id, from its group listing.
 */
export async function listChats(instance: AppInstance, take = 200): Promise<ChatSummary[]> {
  const evolution = evolutionClientForInstance(instance)

  const rows = await evolution<EvolutionChatRow[]>(
    `/chat/findChats/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { take } },
  ).catch(() => [] as EvolutionChatRow[])

  if (!Array.isArray(rows)) return []

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
        unreadCount: Number(row.unreadCount ?? 0),
        lastMessagePreview: previewOf(row.lastMessage?.message),
      }
    })

  // Only pay for the group listing when it can change an answer — every group
  // that the chat rows alone already name is a round trip per group we skip.
  const needsGroups = drafts.some(draft => draft.isGroup && !draft.chatName)

  const [contacts, groups] = await Promise.all([
    fetchContacts(instance, evolution),
    needsGroups ? fetchGroups(instance, evolution) : Promise.resolve(emptyGroups),
  ])

  return drafts.map((draft) => {
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
      unreadCount: draft.unreadCount,
      lastMessagePreview: draft.lastMessagePreview,
    }
  })
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
}

/**
 * Message history for one chat, newest first.
 *
 * Evolution only applies its timestamp filter when **both** bounds are present
 * (`baileys.svc.ts` checks `gte && lte` and ignores the filter otherwise), so a
 * one-sided range is widened here rather than passed through and silently dropped.
 *
 * There is no text search upstream: Evolution's `findMessages` accepts a
 * `where.message` and never reads it, so a content filter passed here comes back
 * as an unfiltered page. Do not offer one from this function — `searchMessages`
 * in `evolution-db.ts` reads Evolution's database directly for that.
 */
export async function listMessages(
  instance: AppInstance,
  remoteJid: string,
  query: MessageQuery = {},
): Promise<ChatMessage[]> {
  const evolution = evolutionClientForInstance(instance)

  const { limit = 50, page = 1, since, until } = query

  const where: Record<string, unknown> = { key: { remoteJid } }
  if (since || until) {
    where.messageTimestamp = {
      gte: since ?? EPOCH_ISO,
      lte: until ?? new Date().toISOString(),
    }
  }

  const result = await evolution<{ messages?: { records?: EvolutionMessageRow[] } } | EvolutionMessageRow[]>(
    `/chat/findMessages/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { where, page, offset: limit } },
  )

  const records = Array.isArray(result)
    ? result
    : result?.messages?.records ?? []

  return records.map(row => ({
    id: row.key?.id,
    fromMe: Boolean(row.key?.fromMe),
    author: row.pushName ?? undefined,
    timestamp: row.messageTimestamp ? new Date(Number(row.messageTimestamp) * 1000).toISOString() : undefined,
    type: row.messageType ?? undefined,
    text: previewOf(row.message),
  }))
}

// ── naming ─────────────────────────────────────────────────────────────────

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

/**
 * A name worth showing, or nothing.
 *
 * Evolution falls back to the bare number when it has no real name — in
 * `Contact.pushName` and on a chat row alike — so a "name" equal to the JID's
 * local part carries no information. Returning undefined lets the next candidate
 * be tried instead of ending the search on a number dressed up as a name.
 */
function meaningfulName(value: string | undefined | null, localPart: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === localPart) return undefined
  return trimmed
}

// ── internals ──────────────────────────────────────────────────────────────

/**
 * Lower bound for a one-sided range. Has to be truthy: Evolution tests the raw
 * input value before parsing it, so a `0` here would disable the filter entirely.
 */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

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
  lastMessage?: { message?: unknown }
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

interface EvolutionMessageRow {
  key?: { id?: string, fromMe?: boolean, remoteJid?: string }
  pushName?: string
  messageTimestamp?: number | string
  messageType?: string
  message?: unknown
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
