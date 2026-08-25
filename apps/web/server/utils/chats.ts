import type { AppInstance } from './pocketbase'

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
 */
export async function listChats(instance: AppInstance, take = 200): Promise<ChatSummary[]> {
  const evolution = evolutionClientForInstance(instance)

  const rows = await evolution<EvolutionChatRow[]>(
    `/chat/findChats/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { take } },
  ).catch(() => [] as EvolutionChatRow[])

  if (!Array.isArray(rows)) return []

  return rows
    .filter(row => typeof row?.remoteJid === 'string')
    .map((row) => {
      const jid = row.remoteJid!
      const isGroup = jid.endsWith('@g.us')
      return {
        jid,
        name: row.pushName?.trim() || jid.split('@')[0]!,
        isGroup,
        profilePicUrl: row.profilePicUrl ?? undefined,
        updatedAt: row.updatedAt ?? undefined,
        unreadCount: Number(row.unreadMessages ?? 0),
        lastMessagePreview: previewOf(row.lastMessageMessage),
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
 * There is no text search upstream — do not offer one.
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

// ── internals ──────────────────────────────────────────────────────────────

/**
 * Lower bound for a one-sided range. Has to be truthy: Evolution tests the raw
 * input value before parsing it, so a `0` here would disable the filter entirely.
 */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

interface EvolutionChatRow {
  remoteJid?: string
  pushName?: string
  profilePicUrl?: string
  updatedAt?: string
  unreadMessages?: number
  lastMessageMessage?: unknown
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
