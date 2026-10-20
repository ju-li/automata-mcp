import type { AppInstance } from './app-db'
import type { MailAttachment } from './imap-client'
import type { McpScope } from './mcp-scope'

/**
 * Reads over what the IMAP sync stored: folders, headers, sync state.
 *
 * Every query carries `instance_id = <this connection>`, and folder scope is a
 * predicate in SQL — the same two rules the WhatsApp and Telegram readers keep,
 * for the same reasons. Bodies and attachments are not here; they are not in
 * the database. See imap-client.ts.
 *
 * **One message filed in several folders is several rows.** IMAP has no
 * account-wide message identity, and Gmail exposes each label as a folder, so
 * an email labelled "Clients" sits in INBOX and in Clients with different
 * UIDs. A listing across folders collapses rows sharing a `Message-ID`, and
 * the survivor carries every folder in `folders`; a listing of one folder
 * cannot meet a duplicate and is not collapsed. Without this, one email reads
 * as two, counts double, and a model summarising "what came in" reports it
 * twice.
 */

export interface MailAddress {
  name?: string
  address?: string
}

export interface MailSyncState {
  identity: string
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastErrorCode?: string
  lastErrorAt?: string
  authFailed: boolean
}

export interface MailFolder {
  path: string
  name: string
  specialUse?: string
  /** Skipped folders (All Mail, Junk, Trash, unselectable) are listed but hold no rows. */
  synced: boolean
  /** Messages the server reported in the folder at the last sync. */
  serverMessages?: number
  /** Messages synced. Below `serverMessages` while the backfill runs or after it stopped. */
  syncedMessages: number
  unread: number
  lastSyncedAt?: string
  history: {
    /** The oldest message in the folder has been synced. */
    complete: boolean
    /** Why it stopped short: the age limit or the count limit. */
    stopped?: 'days' | 'count'
    oldestSyncedAt?: string
  }
  uidvalidity?: string
}

export interface MailRow {
  folderPath: string
  uidvalidity: string
  uid: string
  messageId?: string
  inReplyTo?: string
  references: string[]
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  cc: MailAddress[]
  sentAt?: string
  receivedAt: string
  flags: string[]
  size?: number
  textPart?: string
  htmlPart?: string
  attachments: MailAttachment[]
  /** Every folder this message is filed in, when read across folders. */
  folders: string[]
}

/**
 * The folders a token may reach, or undefined for an all-folders token.
 *
 * Stored in `chat_jids`: a token is bound to one connection of one kind, so
 * the column means folders on a mail token the way it means marked ids on a
 * Telegram one. Folder paths are the server's own strings and need no
 * validation beyond being non-empty.
 */
export function scopedMailFolders(scope: McpScope): string[] | undefined {
  if (scope.allChats) return undefined
  return scope.chatJids.filter(path => path.length > 0)
}

/** Refuse loudly, naming the folder — an empty answer would read as "no mail". */
export function assertFolderAllowed(scope: McpScope, path: string): void {
  const allowed = scopedMailFolders(scope)
  if (!allowed || allowed.includes(path)) return
  throw createError({
    statusCode: 403,
    message: `This connector token is not scoped to the folder "${path}". Ask the account owner to add it to the token's allowed folders.`,
  })
}

/**
 * The opaque id a tool hands out for one stored row. It names the folder, the
 * folder's UIDVALIDITY and the UID, so a later fetch can tell a renumbered
 * folder from a missing message. Opaque to the model, not secret: decoding
 * one reveals a folder name the caller was already shown.
 */
export function encodeEmailId(row: Pick<MailRow, 'folderPath' | 'uidvalidity' | 'uid'>): string {
  return Buffer.from(JSON.stringify([row.folderPath, row.uidvalidity, row.uid])).toString('base64url')
}

export function decodeEmailId(emailId: string): { folderPath: string, uidvalidity: string, uid: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(emailId, 'base64url').toString('utf8'))
    if (Array.isArray(parsed) && parsed.length === 3
      && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && typeof parsed[2] === 'string'
      && /^\d{1,20}$/.test(parsed[1]) && /^\d{1,20}$/.test(parsed[2])) {
      return { folderPath: parsed[0], uidvalidity: parsed[1], uid: parsed[2] }
    }
  }
  catch {}
  throw createError({
    statusCode: 400,
    message: '`emailId` is not one this connector issued. Take ids from list-emails or search-emails, unchanged.',
  })
}

export async function mailSyncState(instance: Pick<AppInstance, 'id'>): Promise<MailSyncState | undefined> {
  const sql = await appDb()
  const [row] = await sql<Array<{
    identity: string
    last_attempt_at?: string
    last_success_at?: string
    last_error_code?: string
    last_error_at?: string
    auth_failed: boolean
  }>>`
    SELECT identity, last_attempt_at, last_success_at, last_error_code, last_error_at, auth_failed
    FROM app.mail_sync_state WHERE instance_id = ${instance.id}`
  if (!row) return undefined
  return {
    identity: row.identity,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    authFailed: row.auth_failed,
  }
}

interface FolderDbRow {
  path: string
  name: string
  special_use?: string
  synced: boolean
  uidvalidity?: string
  server_messages?: number
  backfill_complete: boolean
  backfill_stopped?: 'days' | 'count'
  last_synced_at?: string
  synced_messages: string
  unread: string
  oldest_synced_at?: string
}

/** The mailbox's folders, scope applied, INBOX first. */
export async function listMailFolders(
  instance: Pick<AppInstance, 'id'>,
  options: { allowed?: string[], q?: string } = {},
): Promise<MailFolder[]> {
  const sql = await appDb()
  const rows = await sql<FolderDbRow[]>`
    SELECT f.path, f.name, f.special_use, f.synced, f.uidvalidity::text AS uidvalidity, f.server_messages,
           f.backfill_complete, f.backfill_stopped, f.last_synced_at,
           count(m.uid) AS synced_messages,
           count(m.uid) FILTER (WHERE NOT ('\\Seen' = ANY(m.flags))) AS unread,
           min(m.received_at) AS oldest_synced_at
    FROM app.mail_folders f
    LEFT JOIN app.mail_messages m ON m.instance_id = f.instance_id AND m.folder_path = f.path
    WHERE f.instance_id = ${instance.id}
      ${options.allowed ? sql`AND f.path = ANY(${options.allowed}::text[])` : sql``}
      ${options.q ? sql`AND f.path ILIKE ${`%${escapeLike(options.q)}%`}` : sql``}
    GROUP BY f.instance_id, f.path
    ORDER BY (f.path = 'INBOX') DESC, f.synced DESC, f.path`
  return rows.map(row => ({
    path: row.path,
    name: row.name || row.path,
    ...(row.special_use && { specialUse: row.special_use }),
    synced: row.synced,
    ...(row.server_messages !== undefined && { serverMessages: row.server_messages }),
    syncedMessages: Number(row.synced_messages),
    unread: Number(row.unread),
    ...(row.last_synced_at && { lastSyncedAt: row.last_synced_at }),
    history: {
      complete: row.backfill_complete,
      ...(row.backfill_stopped && { stopped: row.backfill_stopped }),
      ...(row.oldest_synced_at && { oldestSyncedAt: row.oldest_synced_at }),
    },
    ...(row.uidvalidity && { uidvalidity: row.uidvalidity }),
  }))
}

export interface MailPageOptions {
  /** One folder. Absent means every synced folder in scope, collapsed by Message-ID. */
  folder?: string
  /** The only folders this token may reach. Omit for an all-folders token. */
  allowed?: string[]
  limit: number
  /** 1-based, newest first. */
  page: number
  since?: Date
  until?: Date
  unread?: boolean
  flagged?: boolean
  hasAttachments?: boolean
  /** Substring of a sender's name or address. */
  from?: string
  /** Substring of a To or Cc recipient's name or address. */
  to?: string
  /** Words in the subject, or a substring of it. */
  subject?: string
  /** Restrict to these UIDs per folder — the result of a server-side body search. */
  uids?: Array<{ path: string, uids: number[] }>
}

interface MessageDbRow {
  folder_path: string
  uidvalidity: string
  uid: string
  message_id?: string
  in_reply_to?: string
  refs: string[]
  subject: string
  from_addr: MailAddress[]
  to_addr: MailAddress[]
  cc_addr: MailAddress[]
  sent_at?: string
  received_at: string
  flags: string[]
  size?: number
  text_part?: string
  html_part?: string
  attachments: MailAttachment[]
  folders?: string[]
  total?: string
}

function toMailRow(row: MessageDbRow): MailRow {
  return {
    folderPath: row.folder_path,
    uidvalidity: row.uidvalidity,
    uid: row.uid,
    ...(row.message_id && { messageId: row.message_id }),
    ...(row.in_reply_to && { inReplyTo: row.in_reply_to }),
    references: row.refs ?? [],
    subject: row.subject,
    from: row.from_addr ?? [],
    to: row.to_addr ?? [],
    cc: row.cc_addr ?? [],
    ...(row.sent_at && { sentAt: row.sent_at }),
    receivedAt: row.received_at,
    flags: row.flags ?? [],
    ...(row.size !== undefined && { size: row.size }),
    ...(row.text_part && { textPart: row.text_part }),
    ...(row.html_part && { htmlPart: row.html_part }),
    attachments: row.attachments ?? [],
    folders: row.folders ?? [row.folder_path],
  }
}

/**
 * One page of synced headers, newest first.
 *
 * `hasMore` from fetching `limit + 1`, never from `total`; `total` is
 * `COUNT(*) OVER ()` over the collapsed set, so it counts emails, not rows.
 * Both rules are the ones `MessagePage` in chats.ts keeps.
 */
export async function listMailPage(
  instance: Pick<AppInstance, 'id'>,
  options: MailPageOptions,
): Promise<{ rows: MailRow[], hasMore: boolean, total?: number }> {
  const sql = await appDb()
  const like = (value: string) => `%${escapeLike(value)}%`
  const addressMatch = (column: 'from_addr' | 'to_addr' | 'cc_addr', value: string) => sql`
    EXISTS (SELECT 1 FROM jsonb_array_elements(m.${sql(column)}) a
            WHERE a->>'address' ILIKE ${like(value)} OR a->>'name' ILIKE ${like(value)})`

  let uidFilter = sql``
  if (options.uids) {
    const paths: string[] = []
    const uids: number[] = []
    for (const entry of options.uids) {
      for (const uid of entry.uids) {
        paths.push(entry.path)
        uids.push(uid)
      }
    }
    uidFilter = sql`AND (m.folder_path, m.uid) IN (SELECT * FROM unnest(${paths}::text[], ${uids}::bigint[]))`
  }

  const filters = sql`
    m.instance_id = ${instance.id}
    ${options.folder !== undefined ? sql`AND m.folder_path = ${options.folder}` : sql``}
    ${options.allowed ? sql`AND m.folder_path = ANY(${options.allowed}::text[])` : sql``}
    ${options.since ? sql`AND m.received_at >= ${options.since}` : sql``}
    ${options.until ? sql`AND m.received_at <= ${options.until}` : sql``}
    ${options.unread === undefined ? sql`` : options.unread
      ? sql`AND NOT ('\\Seen' = ANY(m.flags))`
      : sql`AND '\\Seen' = ANY(m.flags)`}
    ${options.flagged === undefined ? sql`` : options.flagged
      ? sql`AND '\\Flagged' = ANY(m.flags)`
      : sql`AND NOT ('\\Flagged' = ANY(m.flags))`}
    ${options.hasAttachments === undefined ? sql`` : options.hasAttachments
      ? sql`AND jsonb_array_length(m.attachments) > 0`
      : sql`AND jsonb_array_length(m.attachments) = 0`}
    ${options.from ? sql`AND ${addressMatch('from_addr', options.from)}` : sql``}
    ${options.to ? sql`AND (${addressMatch('to_addr', options.to)} OR ${addressMatch('cc_addr', options.to)})` : sql``}
    ${options.subject
      ? sql`AND (m.subject_tsv @@ plainto_tsquery('simple', ${options.subject}) OR m.subject ILIKE ${like(options.subject)})`
      : sql``}
    ${uidFilter}`

  const columns = sql`
    m.folder_path, m.uidvalidity::text AS uidvalidity, m.uid::text AS uid, m.message_id, m.in_reply_to, m.refs,
    m.subject, m.from_addr, m.to_addr, m.cc_addr, m.sent_at, m.received_at, m.flags, m.size,
    m.text_part, m.html_part, m.attachments`

  // The tiebreaker travels with the order, so a row sharing a timestamp lands
  // on exactly one page.
  const rows = options.folder !== undefined
    ? await sql<MessageDbRow[]>`
        SELECT ${columns}, COUNT(*) OVER () AS total
        FROM app.mail_messages m
        WHERE ${filters}
        ORDER BY m.received_at DESC, m.uid DESC
        LIMIT ${options.limit + 1} OFFSET ${(options.page - 1) * options.limit}`
    : await sql<MessageDbRow[]>`
        WITH matched AS (
          SELECT ${columns}, m.uid AS uid_num, COALESCE(m.message_id, m.folder_path || ':' || m.uid::text) AS dedupe_key
          FROM app.mail_messages m
          WHERE ${filters}
        ), collapsed AS (
          -- INBOX, then the alphabetically first folder, is the copy that speaks
          -- for the rest: deterministic, so the same call returns the same row.
          SELECT DISTINCT ON (dedupe_key) *,
                 array_agg(folder_path) OVER (PARTITION BY dedupe_key) AS folders
          FROM matched
          ORDER BY dedupe_key, (folder_path = 'INBOX') DESC, folder_path, uid_num
        )
        SELECT *, COUNT(*) OVER () AS total
        FROM collapsed
        ORDER BY received_at DESC, folder_path, uid_num DESC
        LIMIT ${options.limit + 1} OFFSET ${(options.page - 1) * options.limit}`

  const total = Number(rows[0]?.total)
  return {
    rows: rows.slice(0, options.limit).map(toMailRow),
    hasMore: rows.length > options.limit,
    total: Number.isFinite(total) ? total : undefined,
  }
}

/**
 * One stored message, with every folder that holds a copy of it. Undefined
 * when this connection has no such row — the caller answers 404, never a
 * live fetch for a UID the sync did not see.
 */
export async function getMailRow(
  instance: Pick<AppInstance, 'id'>,
  ref: { folderPath: string, uidvalidity: string, uid: string },
  allowed?: string[],
): Promise<MailRow | undefined> {
  const sql = await appDb()
  const [row] = await sql<MessageDbRow[]>`
    SELECT m.folder_path, m.uidvalidity::text AS uidvalidity, m.uid::text AS uid, m.message_id, m.in_reply_to,
           m.refs, m.subject, m.from_addr, m.to_addr, m.cc_addr, m.sent_at, m.received_at, m.flags, m.size,
           m.text_part, m.html_part, m.attachments,
           CASE WHEN m.message_id IS NULL THEN ARRAY[m.folder_path] ELSE (
             SELECT array_agg(DISTINCT o.folder_path ORDER BY o.folder_path) FROM app.mail_messages o
             WHERE o.instance_id = m.instance_id AND o.message_id = m.message_id
               ${allowed ? sql`AND o.folder_path = ANY(${allowed}::text[])` : sql``}
           ) END AS folders
    FROM app.mail_messages m
    WHERE m.instance_id = ${instance.id} AND m.folder_path = ${ref.folderPath}
      AND m.uid = ${ref.uid} AND m.uidvalidity = ${ref.uidvalidity}`
  return row ? toMailRow(row) : undefined
}

/** Folders in the scope picker's row shape — `jid` carries the path. */
export async function listMailFoldersForPicker(
  instance: Pick<AppInstance, 'id'>,
  q?: string,
): Promise<{ chats: Array<{ jid: string, name: string, isGroup: false, messages: number, synced: boolean }>, hasMore: false, total: number }> {
  const folders = await listMailFolders(instance, { q })
  return {
    hasMore: false,
    total: folders.length,
    chats: folders.map(folder => ({
      jid: folder.path,
      name: folder.path,
      isGroup: false,
      messages: folder.syncedMessages,
      synced: folder.synced,
    })),
  }
}
