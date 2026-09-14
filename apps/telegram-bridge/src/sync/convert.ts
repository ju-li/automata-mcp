import { Api, helpers } from 'teleproto'

/**
 * Telegram's TL objects to the bridge's rows. No I/O, so what a row *means* is
 * decided in one place.
 *
 * Ids leave this module as strings. Telegram ids are 64-bit; a JS number rounds
 * anything past 2^53, and a rounded chat id is a different chat.
 */

/** A channel's or supergroup's marked id is -(10^12 + id); anything at or below this is one. */
export const CHANNEL_MARK = -1_000_000_000_000n

export type ChatType = 'private' | 'bot' | 'group' | 'supergroup' | 'channel'

export interface ChatRow {
  chat_id: string
  type: ChatType
  title: string | null
  username: string | null
  /** NULL for a `min` entity, whose hash cannot address it. Never overwrites a real one. */
  access_hash: string | null
  is_forum: boolean
  participant_count: number | null
  migrated_to: string | null
}

export interface UserRow {
  user_id: string
  first_name: string | null
  last_name: string | null
  username: string | null
  phone: string | null
  access_hash: string | null
  is_bot: boolean
}

export interface Reaction {
  emoji: string
  count: number
}

export interface MessageRow {
  chat_id: string
  message_id: number
  in_channel: boolean
  sender_id: string | null
  from_me: boolean
  date: Date
  edit_date: Date | null
  text: string | null
  media_type: string | null
  entities: Record<string, unknown>[] | null
  mentioned_user_ids: string[]
  reply_to_id: number | null
  topic_id: number | null
  fwd_from: Record<string, unknown> | null
  service_action: Record<string, unknown> | null
  grouped_id: string | null
  reactions: Reaction[] | null
}

/**
 * The Bot API marked id of a peer: a user's own id, `-id` for a basic group,
 * `-(10^12 + id)` for a channel or supergroup.
 *
 * **Never teleproto's `utils.getPeerId`.** It builds a channel's id by string
 * concatenation (`"-100" + id`), which equals `-(10^12 + id)` only while the id
 * has exactly ten digits. Any other length names a different number, which is
 * not recognised as a channel, and its messages land in the private-chat id
 * space. The partial unique index caught exactly that in testing.
 */
export function markedId(peer: Api.TypePeer): string {
  if (peer instanceof Api.PeerUser) return peer.userId.toString()
  if (peer instanceof Api.PeerChat) return `-${peer.chatId.toString()}`
  if (peer instanceof Api.PeerChannel) return channelChatId(peer.channelId)
  throw new Error(`not a peer: ${(peer as { className?: string }).className}`)
}

/** A channel's or supergroup's marked id, from its bare id. */
export function channelChatId(channelId: { toString(): string }): string {
  return (CHANNEL_MARK - BigInt(channelId.toString())).toString()
}

export function isChannelId(chatId: string): boolean {
  return BigInt(chatId) <= CHANNEL_MARK
}

/** What an id alone says about a chat, for a row created before its entity is known. */
export function stubType(chatId: string): ChatType {
  const id = BigInt(chatId)
  if (id > 0n) return 'private'
  return id <= CHANNEL_MARK ? 'supergroup' : 'group'
}

/** The marked id an entity is addressed by, or undefined for one that is not a user or chat. */
export function entityId(entity: unknown): string | undefined {
  if (entity instanceof Api.User) return entity.id.toString()
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) return `-${entity.id.toString()}`
  if (entity instanceof Api.Channel || entity instanceof Api.ChannelForbidden) return channelChatId(entity.id)
  return undefined
}

/**
 * Entities keyed by marked id. Also the way to read teleproto's own `_entities`
 * map on an update, which is keyed with `getPeerId` and so cannot be looked up
 * by a correct channel id: rebuild it with `entityMap([...map.values()])`.
 */
export function entityMap(...lists: unknown[][]): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const entity of lists.flat()) {
    const id = entityId(entity)
    if (id) map.set(id, entity)
  }
  return map
}

export function chatRow(entity: unknown): ChatRow | undefined {
  if (entity instanceof Api.User) {
    return {
      chat_id: entity.id.toString(),
      type: entity.bot ? 'bot' : 'private',
      title: displayName(entity),
      username: entity.username ?? activeUsername(entity.usernames),
      access_hash: entity.min ? null : entity.accessHash?.toString() ?? null,
      is_forum: false,
      participant_count: null,
      migrated_to: null,
    }
  }
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) {
    const migratedTo = entity instanceof Api.Chat && entity.migratedTo instanceof Api.InputChannel
      ? channelChatId(entity.migratedTo.channelId)
      : null
    return {
      chat_id: `-${entity.id.toString()}`,
      type: 'group',
      title: entity.title,
      username: null,
      access_hash: null,
      is_forum: false,
      participant_count: entity instanceof Api.Chat ? entity.participantsCount ?? null : null,
      migrated_to: migratedTo,
    }
  }
  if (entity instanceof Api.Channel || entity instanceof Api.ChannelForbidden) {
    const channel = entity instanceof Api.Channel ? entity : undefined
    return {
      chat_id: channelChatId(entity.id),
      type: entity.broadcast ? 'channel' : 'supergroup',
      title: entity.title,
      username: channel ? channel.username ?? activeUsername(channel.usernames) : null,
      access_hash: channel?.min ? null : entity.accessHash?.toString() ?? null,
      is_forum: Boolean(channel?.forum),
      participant_count: channel?.participantsCount ?? null,
      migrated_to: null,
    }
  }
  return undefined
}

export function userRow(user: Api.User): UserRow {
  return {
    user_id: user.id.toString(),
    first_name: user.firstName ?? null,
    last_name: user.lastName ?? null,
    username: user.username ?? activeUsername(user.usernames),
    phone: user.phone ?? null,
    access_hash: user.min ? null : user.accessHash?.toString() ?? null,
    is_bot: Boolean(user.bot),
  }
}

export function usersOf(entities: Iterable<unknown>): UserRow[] {
  return [...entities].flatMap(entity => entity instanceof Api.User ? [userRow(entity)] : [])
}

export function chatsOf(entities: Iterable<unknown>): ChatRow[] {
  return [...entities].flatMap((entity) => {
    const row = chatRow(entity)
    return row ? [row] : []
  })
}

/**
 * One message, or undefined for a `MessageEmpty` (an id with nothing behind it).
 *
 * The sender, when Telegram omits `fromId`: yourself for an outgoing message;
 * the other person in a 1:1 chat; nobody for a channel post, where there is no
 * person to name.
 */
export function messageRow(message: unknown, meId: string | null): MessageRow | undefined {
  if (!(message instanceof Api.Message) && !(message instanceof Api.MessageService)) return undefined

  const chatId = markedId(message.peerId)
  const fromMe = Boolean(message.out)
  const senderId = message.fromId
    ? markedId(message.fromId)
    : fromMe ? meId : BigInt(chatId) > 0n ? chatId : null

  const isService = message instanceof Api.MessageService
  const entities = isService ? [] : message.entities ?? []
  const reply = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined

  return {
    chat_id: chatId,
    message_id: message.id,
    in_channel: isChannelId(chatId),
    sender_id: senderId,
    from_me: fromMe,
    date: new Date(message.date * 1000),
    edit_date: !isService && message.editDate ? new Date(message.editDate * 1000) : null,
    text: isService ? null : message.message || null,
    media_type: !isService && message.media ? mediaType(message.media) : null,
    entities: entityList(entities),
    mentioned_user_ids: mentionedUsers(entities),
    reply_to_id: reply?.replyToMsgId ?? null,
    topic_id: reply?.forumTopic ? reply.replyToTopId ?? reply.replyToMsgId ?? null : null,
    fwd_from: !isService && message.fwdFrom ? forwardOf(message.fwdFrom) : null,
    service_action: isService ? plainFields(message.action, 'MessageAction') : null,
    grouped_id: !isService && message.groupedId ? message.groupedId.toString() : null,
    reactions: reactionList(message.reactions),
  }
}

/** The compact update forms Telegram uses for a plain text message in a 1:1 chat or a basic group. */
export function shortMessageRow(
  update: Api.UpdateShortMessage | Api.UpdateShortChatMessage,
  meId: string | null,
): MessageRow {
  const fromMe = Boolean(update.out)
  const chatId = update instanceof Api.UpdateShortMessage
    ? update.userId.toString()
    : `-${update.chatId.toString()}`
  const senderId = update instanceof Api.UpdateShortMessage
    ? (fromMe ? meId : chatId)
    : update.fromId.toString()
  const entities = update.entities ?? []
  const reply = update.replyTo instanceof Api.MessageReplyHeader ? update.replyTo : undefined

  return {
    chat_id: chatId,
    message_id: update.id,
    in_channel: false,
    sender_id: senderId,
    from_me: fromMe,
    date: new Date(update.date * 1000),
    edit_date: null,
    text: update.message || null,
    media_type: null,
    entities: entityList(entities),
    mentioned_user_ids: mentionedUsers(entities),
    reply_to_id: reply?.replyToMsgId ?? null,
    topic_id: null,
    fwd_from: update.fwdFrom ? forwardOf(update.fwdFrom) : null,
    service_action: null,
    grouped_id: null,
    reactions: null,
  }
}

/** A basic group upgraded to a supergroup: the old id, and the one it became. */
export function migrationOf(message: unknown): { from: string, to: string } | undefined {
  if (!(message instanceof Api.MessageService)) return undefined
  const here = markedId(message.peerId)
  if (message.action instanceof Api.MessageActionChatMigrateTo) {
    return { from: here, to: channelChatId(message.action.channelId) }
  }
  if (message.action instanceof Api.MessageActionChannelMigrateFrom) {
    return { from: `-${message.action.chatId.toString()}`, to: here }
  }
  return undefined
}

export function reactionList(reactions: unknown): Reaction[] | null {
  if (!(reactions instanceof Api.MessageReactions)) return null
  return reactions.results.map(result => ({
    emoji: result.reaction instanceof Api.ReactionEmoji
      ? result.reaction.emoticon
      : result.reaction instanceof Api.ReactionCustomEmoji
        ? `custom:${result.reaction.documentId.toString()}`
        : result.reaction.className.replace(/^Reaction/, '').toLowerCase(),
    count: result.count,
  }))
}

export function inputPeerFor(chatId: string, accessHash: string | null): Api.TypeInputPeer | undefined {
  const id = BigInt(chatId)
  if (id > 0n) {
    return accessHash === null ? undefined : new Api.InputPeerUser({ userId: long(id), accessHash: long(accessHash) })
  }
  if (id <= CHANNEL_MARK) {
    return accessHash === null
      ? undefined
      : new Api.InputPeerChannel({ channelId: long(-id + CHANNEL_MARK), accessHash: long(accessHash) })
  }
  return new Api.InputPeerChat({ chatId: long(-id) })
}

export function inputChannelFor(chatId: string, accessHash: string): Api.InputChannel {
  return new Api.InputChannel({ channelId: long(-BigInt(chatId) + CHANNEL_MARK), accessHash: long(accessHash) })
}

export function long(value: bigint | string | number) {
  return helpers.returnBigInt(value.toString())
}

// ── internals ────────────────────────────────────────────────────────────────

function displayName(user: Api.User): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || null
}

function activeUsername(usernames: Api.TypeUsername[] | undefined): string | null {
  const active = usernames?.find(entry => entry instanceof Api.Username && entry.active)
  return active instanceof Api.Username ? active.username : null
}

function mediaType(media: Api.TypeMessageMedia): string | null {
  if (media instanceof Api.MessageMediaEmpty) return null
  const name = media.className.replace(/^MessageMedia/, '')
  return name.charAt(0).toLowerCase() + name.slice(1)
}

function entityList(entities: Api.TypeMessageEntity[]): Record<string, unknown>[] | null {
  if (entities.length === 0) return null
  return entities.map(entity => ({
    type: entity.className.replace(/^MessageEntity/, ''),
    offset: entity.offset,
    length: entity.length,
    ...(entity instanceof Api.MessageEntityMentionName && { userId: entity.userId.toString() }),
    ...(entity instanceof Api.MessageEntityTextUrl && { url: entity.url }),
  }))
}

function mentionedUsers(entities: Api.TypeMessageEntity[]): string[] {
  return entities.flatMap(entity => entity instanceof Api.MessageEntityMentionName ? [entity.userId.toString()] : [])
}

function forwardOf(header: Api.TypeMessageFwdHeader): Record<string, unknown> {
  return {
    fromId: header.fromId ? markedId(header.fromId) : null,
    fromName: header.fromName ?? null,
    date: new Date(header.date * 1000).toISOString(),
    channelPost: header.channelPost ?? null,
  }
}

const SKIPPED_FIELDS = new Set(['CONSTRUCTOR_ID', 'SUBCLASS_OF_ID', 'classType', 'className', 'originalArgs'])

/**
 * A service action as JSON: its type and its scalar fields, bigints as strings.
 * Nested TL objects are left out rather than serialised whole — photos and
 * byte buffers are not what a reader of "who joined" needs.
 */
function plainFields(object: { className: string }, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = { type: object.className.replace(new RegExp(`^${prefix}`), '') }
  for (const [key, value] of Object.entries(object)) {
    if (SKIPPED_FIELDS.has(key) || key.startsWith('_')) continue
    const plain = plainValue(value)
    if (plain !== undefined) out[key] = plain
  }
  return out
}

function plainValue(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value && typeof value === 'object' && typeof (value as { toJSNumber?: unknown }).toJSNumber === 'function') {
    return String(value)
  }
  if (Array.isArray(value)) {
    const items = value.map(plainValue).filter(item => item !== undefined)
    return items.length > 0 ? items : undefined
  }
  return undefined
}
