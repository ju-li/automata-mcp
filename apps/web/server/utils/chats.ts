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
 * Evolution builds this listing from its Message table, so **a chat only exists
 * here once it has exchanged a message since pairing**. A freshly paired account
 * returns nothing, which is not an error — it is why the UI also lets a number
 * be added by hand.
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

/** Message history for one chat, newest first. */
export async function listMessages(instance: AppInstance, remoteJid: string, limit = 50): Promise<ChatMessage[]> {
  const evolution = evolutionClientForInstance(instance)

  const result = await evolution<{ messages?: { records?: EvolutionMessageRow[] } } | EvolutionMessageRow[]>(
    `/chat/findMessages/${encodeURIComponent(instance.name)}`,
    { method: 'POST', body: { where: { key: { remoteJid } }, page: 1, offset: limit } },
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
