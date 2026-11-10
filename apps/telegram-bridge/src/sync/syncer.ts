import { Api, events, type TelegramClient } from 'teleproto'
import type { Sql } from '../db.ts'
import { describeError } from '../http-error.ts'
import {
  channelChatId, chatRow, chatsOf, entityMap, inputChannelFor, inputPeerFor, long, markedId,
  type MessageRow, messageRow, migrationOf, reactionList, shortMessageRow, type UserRow, userRow, usersOf,
} from './convert.ts'
import { type BackfillChat, type BackfillStop, type ChatOp, SyncStore } from './store.ts'

/**
 * Keeping one session's chats in Postgres.
 *
 * Four sources, because no one of them is complete:
 *
 *   live       Every update teleproto dispatches, applied in arrival order —
 *              written in batches: see `drain`.
 *   catch-up   On connect: teleproto's common difference (private chats, basic
 *              groups) from the persisted pts, then **our own** channel
 *              difference per channel from `chats.channel_pts`. teleproto only
 *              tracks channels it saw an update for in this process, so after a
 *              restart it would miss every channel's offline edits and deletes.
 *   dialogs    The dialog list, on connect and every RECONCILE_MS. A chat whose
 *              top message is newer than what we hold is filled forward. This is
 *              what covers channels Telegram stopped pushing while nobody polled.
 *   backfill   Older history, newest chat first, one page at a time, bounded by
 *              the configured caps and paused on flood waits.
 *
 * What cannot be recovered is recorded, not hidden: a forward fill or channel
 * difference that could not reach back far enough sets `chats.gap_since`.
 */

export interface BackfillOptions {
  maxPerChat: number
  days: number
  includeBroadcast: boolean
  pageDelayMs: number
}

export interface SyncStatus {
  backfilling: boolean
  pausedUntil?: string
}

const PAGE = 100
const RECONCILE_MS = 10 * 60_000
const RECONCILE_DIALOGS = 100
const MAX_FORWARD_PAGES = 50
const CHANNEL_CATCHUP_DELAY_MS = 250
const MAX_CHANNEL_DIFFERENCE_ROUNDS = 50
/** A flood wait longer than this is logged: it means this account is syncing too hard. */
const LONG_FLOOD_S = 300
/**
 * Most queued live updates one transaction writes. Bounds the statement size
 * (columns × rows parameters) as much as the work lost to one failed batch.
 */
const MAX_BATCH = 500
/** How often backfill looks again while the client is disconnected. */
const DISCONNECTED_WAIT_MS = 30_000
/** Telegram's answer for history this account cannot read any more. */
const INACCESSIBLE = new Set(['CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'PEER_ID_INVALID', 'CHAT_ID_INVALID', 'CHAT_FORBIDDEN'])

type EntityMap = Map<string, unknown>

export class SessionSync {
  private readonly client: TelegramClient
  private readonly store: SyncStore
  private readonly options: BackfillOptions
  private readonly sessionId: string
  private readonly meId: string | null
  private readonly rawEvent = new events.Raw({})
  private readonly onUpdate = (update: unknown) => { this.enqueue(update) }
  private readonly pending: unknown[] = []
  private draining = false
  private stopped = false
  private syncingDialogs = false
  private backfillRunning = false
  private pausedUntil = 0
  private reconcileTimer: NodeJS.Timeout | undefined
  private backfilling = false

  constructor(client: TelegramClient, sql: Sql, sessionId: string, meId: string | null, options: BackfillOptions) {
    this.client = client
    this.store = new SyncStore(sql, sessionId)
    this.sessionId = sessionId
    this.meId = meId
    this.options = options
  }

  /** Before connecting, so nothing teleproto dispatches during catch-up is missed. */
  attach(): void {
    this.client.addEventHandler(this.onUpdate, this.rawEvent)
  }

  /** After connecting and confirming the session. Never throws; failures are logged and retried by reconcile. */
  async start(): Promise<void> {
    await this.guard('catch-up', () => this.client.catchUp())
    await this.guard('channel catch-up', () => this.catchUpChannels())
    await this.guard('dialog sync', async () => {
      await this.syncDialogs()
      if (!this.stopped) await this.store.markDialogsSynced()
    })
    if (this.stopped) return
    this.reconcileTimer = setInterval(() => { void this.reconcile() }, RECONCILE_MS)
    this.reconcileTimer.unref()
    void this.runBackfill()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.reconcileTimer)
    this.client.removeEventHandler(this.onUpdate, this.rawEvent)
  }

  status(): SyncStatus {
    return {
      backfilling: this.backfilling,
      pausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : undefined,
    }
  }

  /** The update manager's common state, to persist so the next connect catches up from it. */
  updateState(): { pts: number, qts: number, date: number, seq: number } | undefined {
    return this.client.updateManager.state
  }

  /** Store messages and the chats they belong to. Used by live updates, history pages and sends. */
  async saveMessages(messages: unknown[], entities?: EntityMap): Promise<void> {
    const rows = messages.flatMap((message) => {
      const row = messageRow(message, this.meId)
      return row ? [row] : []
    })
    if (rows.length === 0) return

    await this.store.writeBatch({
      chats: [...new Set(rows.map(row => row.chat_id))].map(chatId => chatOp(chatId, entities)),
      messages: rows,
      migrations: messages.flatMap(message => migrationOf(message) ?? []),
    })
  }

  // ── live ───────────────────────────────────────────────────────────────────

  private enqueue(update: unknown): void {
    this.pending.push(update)
    if (!this.draining) void this.drain()
  }

  /**
   * Apply queued updates in arrival order, as few writes as possible.
   *
   * A run of consecutive batchable updates (`batchable`) is written as one
   * transaction with one statement per table, instead of about six round trips
   * per message — the per-message path could not keep up with a busy account,
   * and the backlog grew without bound (#188, #189). Any other update ends the
   * run: the run is written, the update applied on its own, then a new run
   * starts, so deletions, reactions and catch-ups still land in arrival order
   * relative to the messages around them.
   *
   * Never throws: a failed batch is retried one update at a time, so one bad
   * row costs one update, not the batch.
   */
  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.pending.length > 0) {
        if (this.stopped) {
          this.pending.length = 0
          return
        }
        let run = 0
        while (run < this.pending.length && run < MAX_BATCH && batchable(this.pending[run])) run++
        if (run > 0) await this.applyBatch(this.pending.splice(0, run))
        else await this.applyOne(this.pending.shift())
      }
    }
    finally {
      this.draining = false
    }
  }

  private async applyOne(update: unknown): Promise<void> {
    try {
      await this.apply(update)
    }
    catch (error) {
      const name = (update as { className?: string } | undefined)?.className ?? 'update'
      console.error(`[sync] ${this.sessionId}: could not apply ${name}: ${describeError(error)}`)
    }
  }

  private async applyBatch(updates: unknown[]): Promise<void> {
    if (updates.length === 1) return await this.applyOne(updates[0])
    try {
      await this.writeBatch(updates)
    }
    catch (error) {
      if (this.stopped) return
      console.error(`[sync] ${this.sessionId}: a batch of ${updates.length} updates failed (${describeError(error)}); applying them one at a time`)
      for (const update of updates) {
        if (this.stopped) return
        await this.applyOne(update)
      }
    }
  }

  /**
   * What `apply` would write for each of `updates` in turn, as one batch. Every
   * update here passed `batchable`, so it is entities plus, at most, one
   * message upsert and a forward-only pts.
   */
  private async writeBatch(updates: unknown[]): Promise<void> {
    if (this.stopped) return
    const users: UserRow[] = []
    const chats: ChatOp[] = []
    const messages: MessageRow[] = []
    const channelPts = new Map<string, number>()

    for (const update of updates) {
      const entities = entitiesOf(update)
      if (entities) {
        const list = [...entities.values()]
        users.push(...usersOf(list))
        chats.push(...chatsOf(list).map(row => ({ op: 'refresh' as const, row })))
      }
      if (!isMessageUpdate(update)) continue

      const row = messageRow(update.message, this.meId)
      if (row) {
        chats.push(chatOp(row.chat_id, entities))
        messages.push(row)
      }
      const pts = channelPtsOf(update)
      if (pts) channelPts.set(pts.chatId, Math.max(channelPts.get(pts.chatId) ?? 0, pts.pts))
    }

    await this.store.writeBatch({ users, chats, messages, channelPts })
  }

  /**
   * One update on its own. Every class handled here other than a message upsert
   * must be listed in ORDERED, or the batch path will treat it as entities only.
   */
  private async apply(update: unknown): Promise<void> {
    if (this.stopped) return
    const entities = entitiesOf(update)
    if (entities) await this.absorb(entities.values())

    if (isMessageUpdate(update)) {
      await this.saveMessages([update.message], entities)
      const pts = channelPtsOf(update)
      if (pts) await this.store.setChannelPts(pts.chatId, pts.pts, false)
    }
    else if (update instanceof Api.UpdateShortMessage || update instanceof Api.UpdateShortChatMessage) {
      const row = shortMessageRow(update, this.meId)
      await this.store.ensureChats([row.chat_id])
      await this.store.upsertMessages([row])
    }
    else if (update instanceof Api.UpdateDeleteMessages) {
      await this.store.tombstoneCommon(update.messages)
    }
    else if (update instanceof Api.UpdateDeleteChannelMessages) {
      const chatId = channelChatId(update.channelId)
      await this.store.tombstoneInChat(chatId, update.messages)
      if (update.ptsCount > 0) await this.store.setChannelPts(chatId, update.pts, false)
    }
    else if (update instanceof Api.UpdateMessageReactions) {
      await this.store.setReactions(markedId(update.peer), update.msgId, reactionList(update.reactions))
    }
    else if (update instanceof Api.UpdateChannelTooLong) {
      const chat = await this.store.chat(channelChatId(update.channelId))
      const [tracked] = (await this.store.channelsForCatchUp()).filter(row => row.chat_id === chat?.chat_id)
      if (tracked) await this.guard('channel catch-up', () => this.catchUpChannel(tracked))
    }
  }

  private async absorb(entities: Iterable<unknown>): Promise<void> {
    const list = [...entities]
    await this.store.upsertUsers(usersOf(list))
    await this.store.refreshKnownChats(chatsOf(list))
  }

  // ── catch-up ───────────────────────────────────────────────────────────────

  private async catchUpChannels(): Promise<void> {
    for (const channel of await this.store.channelsForCatchUp()) {
      if (this.stopped) return
      await this.guard(`catch-up of ${channel.chat_id}`, () => this.catchUpChannel(channel))
      await sleep(CHANNEL_CATCHUP_DELAY_MS)
    }
  }

  private async catchUpChannel(channel: { chat_id: string, access_hash: string, channel_pts: number }): Promise<void> {
    const input = inputChannelFor(channel.chat_id, channel.access_hash)
    let pts = channel.channel_pts

    for (let round = 0; round < MAX_CHANNEL_DIFFERENCE_ROUNDS && !this.stopped; round++) {
      let diff: Api.updates.TypeChannelDifference
      try {
        diff = await this.client.invoke(new Api.updates.GetChannelDifference({
          channel: input,
          filter: new Api.ChannelMessagesFilterEmpty(),
          pts,
          limit: PAGE,
          force: true,
        }))
      }
      catch (error) {
        const code = describeError(error)
        if (INACCESSIBLE.has(code) || code === 'PERSISTENT_TIMESTAMP_INVALID') {
          // Left, banned, or a pts Telegram no longer recognises: stop tracking
          // it here; the next dialog sync sets a fresh pts if the chat is back.
          await this.store.setChannelPts(channel.chat_id, null, true)
          return
        }
        throw error
      }

      if (diff instanceof Api.updates.ChannelDifferenceEmpty) {
        await this.store.setChannelPts(channel.chat_id, diff.pts, true)
        return
      }

      const entities = entityMap(diff.users, diff.chats)
      await this.absorb(entities.values())

      if (diff instanceof Api.updates.ChannelDifferenceTooLong) {
        // Telegram will not replay this far back: take the latest messages it
        // offers, fill forward from what we held, and record that edits and
        // deletions in between are unknown.
        const storedMax = await this.store.maxMessageId(channel.chat_id)
        await this.saveMessages(diff.messages, entities)
        await this.store.setGap(channel.chat_id)
        if (diff.dialog instanceof Api.Dialog && diff.dialog.pts !== undefined) {
          await this.store.setChannelPts(channel.chat_id, diff.dialog.pts, true)
        }
        if (storedMax !== null) await this.fillForward(channel.chat_id, storedMax)
        return
      }

      await this.saveMessages(diff.newMessages, entities)
      for (const other of diff.otherUpdates) {
        await this.apply(Object.assign(other, { _entities: entities }))
      }
      pts = diff.pts
      await this.store.setChannelPts(channel.chat_id, pts, true)
      if (diff.final) return
    }
  }

  // ── dialogs ────────────────────────────────────────────────────────────────

  private async syncDialogs(limit?: number): Promise<void> {
    if (this.syncingDialogs) return
    this.syncingDialogs = true
    try {
      for await (const dialog of this.client.iterDialogs(limit ? { limit } : {})) {
        if (this.stopped) return
        const entity = dialog.entity
        const row = entity ? chatRow(entity) : undefined
        if (!row) continue

        const storedMax = await this.store.maxMessageId(row.chat_id)
        await this.store.upsertChats([row])
        if (entity instanceof Api.User) await this.store.upsertUsers([userRow(entity)])
        await this.store.updateDialog(row.chat_id, {
          topMessageId: dialog.dialog.topMessage,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.date ? new Date(dialog.date * 1000) : null,
          archived: dialog.archived,
          pts: dialog.dialog.pts ?? null,
        })
        if (dialog.message) await this.saveMessages([dialog.message])
        if (storedMax !== null && dialog.dialog.topMessage > storedMax) {
          await this.fillForward(row.chat_id, storedMax)
        }
      }
    }
    finally {
      this.syncingDialogs = false
    }
  }

  private async reconcile(): Promise<void> {
    // Disconnected: every request would fail. The session manager rebuilds the
    // client (and this syncer with it); nothing to do here meanwhile.
    if (this.stopped || Date.now() < this.pausedUntil || !this.client.connected) return
    await this.guard('reconcile', () => this.syncDialogs(RECONCILE_DIALOGS))
    void this.runBackfill()
  }

  /** Messages newer than `minId`, newest first, until they meet what we already hold. */
  private async fillForward(chatId: string, minId: number): Promise<void> {
    const chat = await this.store.chat(chatId)
    const peer = chat ? inputPeerFor(chatId, chat.access_hash) : undefined
    if (!peer) return

    let offsetId = 0
    for (let page = 0; page < MAX_FORWARD_PAGES; page++) {
      if (this.stopped) return
      const result = await this.history(peer, { offsetId, minId })
      await this.saveMessages(result.messages, result.entities)
      if (result.ids.length < PAGE) return
      offsetId = Math.min(...result.ids)
      if (offsetId <= minId + 1) return
      await sleep(this.options.pageDelayMs)
    }
    // More than MAX_FORWARD_PAGES behind: say so rather than pretend continuity.
    await this.store.setGap(chatId)
  }

  // ── backfill ───────────────────────────────────────────────────────────────

  private async runBackfill(): Promise<void> {
    if (this.backfillRunning) return
    this.backfillRunning = true
    try {
      while (!this.stopped) {
        const wait = this.pausedUntil - Date.now()
        if (wait > 0) {
          await sleep(Math.min(wait, 60_000))
          continue
        }
        // teleproto reconnecting, or given up: wait rather than fail a page a minute.
        if (!this.client.connected) {
          await sleep(DISCONNECTED_WAIT_MS)
          continue
        }

        const chat = await this.store.nextBackfillChat()
        if (!chat) return

        this.backfilling = true
        try {
          await this.backfillPage(chat)
        }
        catch (error) {
          const code = describeError(error)
          if (isFlood(error)) this.pause(error)
          else if (INACCESSIBLE.has(code)) await this.store.stopBackfill(chat.chat_id, 'inaccessible')
          else {
            console.error(`[sync] ${this.sessionId}: backfill of ${chat.chat_id} failed: ${code}`)
            this.pausedUntil = Date.now() + 60_000
          }
        }
        await sleep(this.options.pageDelayMs)
      }
    }
    catch (error) {
      console.error(`[sync] ${this.sessionId}: backfill stopped: ${describeError(error)}`)
    }
    finally {
      this.backfilling = false
      this.backfillRunning = false
    }
  }

  private async backfillPage(chat: BackfillChat): Promise<void> {
    if (chat.type === 'channel' && !this.options.includeBroadcast) {
      return await this.store.stopBackfill(chat.chat_id, 'skipped')
    }
    if (chat.backfill_count >= this.options.maxPerChat) {
      return await this.store.stopBackfill(chat.chat_id, 'count')
    }
    const peer = inputPeerFor(chat.chat_id, chat.access_hash)
    if (!peer) return await this.store.stopBackfill(chat.chat_id, 'inaccessible')

    const result = await this.history(peer, { offsetId: Number(chat.backfill_cursor ?? 0) })
    await this.saveMessages(result.messages, result.entities)

    const dates = result.messages.flatMap(message =>
      message instanceof Api.Message || message instanceof Api.MessageService ? [message.date] : [])
    const oldest = dates.length > 0 ? new Date(Math.min(...dates) * 1000) : null
    const count = chat.backfill_count + dates.length

    let stopped: BackfillStop | null = null
    if (result.ids.length === 0) stopped = 'start'
    else if (oldest && oldest.getTime() < Date.now() - this.options.days * 86_400_000) stopped = 'days'
    else if (count >= this.options.maxPerChat) stopped = 'count'

    await this.store.recordBackfill(chat.chat_id, {
      cursor: result.ids.length > 0 ? Math.min(...result.ids) : null,
      added: dates.length,
      oldest,
      stopped,
    })
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async history(peer: Api.TypeInputPeer, params: { offsetId: number, minId?: number }) {
    const result = await this.client.invoke(new Api.messages.GetHistory({
      peer,
      offsetId: params.offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit: PAGE,
      maxId: 0,
      minId: params.minId ?? 0,
      hash: long(0),
    }))
    if (result instanceof Api.messages.MessagesNotModified) {
      return { messages: [] as Api.TypeMessage[], ids: [] as number[], entities: new Map<string, unknown>() }
    }
    return {
      messages: result.messages,
      ids: result.messages.map(message => message.id),
      entities: entityMap(result.users, result.chats),
    }
  }

  private async guard(label: string, task: () => Promise<unknown>): Promise<void> {
    if (this.stopped) return
    try {
      await task()
    }
    catch (error) {
      if (this.stopped) return
      if (isFlood(error)) this.pause(error)
      console.error(`[sync] ${this.sessionId}: ${label} failed: ${describeError(error)}`)
    }
  }

  private pause(error: unknown): void {
    const seconds = Number((error as { seconds?: unknown }).seconds) || 60
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + (seconds + Math.random() * 5) * 1000)
    if (seconds > LONG_FLOOD_S) {
      console.error(`[sync] ${this.sessionId}: Telegram asked this account to wait ${seconds}s; sync is paused until then`)
    }
  }
}

type MessageUpdate = Api.UpdateNewMessage | Api.UpdateEditMessage | Api.UpdateNewChannelMessage | Api.UpdateEditChannelMessage

/**
 * Updates `apply` handles that are not a message upsert. Each one's effect
 * depends on where it lands among the upserts around it — a tombstone must
 * follow the message it deletes, a reaction count is replaced wholesale, a
 * catch-up sets pts exactly — so it ends a batch and is applied on its own.
 * Short messages are here only because `apply` stores them by a separate path.
 */
const ORDERED = [
  Api.UpdateShortMessage, Api.UpdateShortChatMessage, Api.UpdateDeleteMessages,
  Api.UpdateDeleteChannelMessages, Api.UpdateMessageReactions, Api.UpdateChannelTooLong,
]

function isMessageUpdate(update: unknown): update is MessageUpdate {
  return update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateEditMessage
    || update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateEditChannelMessage
}

/**
 * Whether an update may share a batch: a message upsert that is not a group
 * migration (whose `markMigrated` stays on the one-at-a-time path), or an update
 * `apply` reads only for its entities. Never throws: `drain` must not, and an
 * update this cannot read goes to `applyOne`, which logs it.
 */
function batchable(update: unknown): boolean {
  try {
    if (isMessageUpdate(update)) return migrationOf(update.message) === undefined
    return !ORDERED.some(type => update instanceof type)
  }
  catch {
    return false
  }
}

/**
 * The entities teleproto attached to an update, re-keyed: teleproto keys this
 * map with getPeerId, which mis-marks channel ids that are not ten digits long;
 * rebuilt so a lookup by a correct id finds its entity.
 */
function entitiesOf(update: unknown): EntityMap | undefined {
  const attached = (update as { _entities?: EntityMap } | undefined)?._entities
  return attached && attached.size > 0 ? entityMap([...attached.values()]) : undefined
}

/** The channel pts a live message update moves forward, if any. pts 0 marks a message teleproto synthesised from a difference. */
function channelPtsOf(update: MessageUpdate): { chatId: string, pts: number } | undefined {
  const isChannelUpdate = update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateEditChannelMessage
  if (!isChannelUpdate || update.ptsCount <= 0) return undefined
  if (!('peerId' in update.message) || !update.message.peerId) return undefined
  return { chatId: markedId(update.message.peerId), pts: update.pts }
}

/** The chat write for a stored message: its entity when the update carried one, else a stub. */
function chatOp(chatId: string, entities: EntityMap | undefined): ChatOp {
  const row = entities?.has(chatId) ? chatRow(entities.get(chatId)) : undefined
  return row ? { op: 'upsert', row } : { op: 'stub', chatId }
}

function isFlood(error: unknown): boolean {
  return /^FLOOD_(PREMIUM_)?WAIT/.test(describeError(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}
