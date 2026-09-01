import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { AppInstance } from './pocketbase'
import { mentionedJidsOf } from './mentions'

/**
 * Read-only access to Evolution's own Postgres — every message this app reads.
 *
 * **Why this exists.** Evolution 2.3.7 cannot search message content. Its
 * `POST /chat/findMessages` looks like it can — the request schema in
 * `src/validate/chat.schema.ts` declares `where.message` as an object — but the
 * field is read exactly zero times in `fetchMessages`. Sending a `where.message`
 * returns the whole unfiltered page, which reads as "these are your matches" and
 * is not. The seven filters it does honour are `id`, `source`, `messageType`,
 * `messageTimestamp` (both bounds or none) and `key.{id,remoteJid,fromMe,participant}`.
 * No other endpoint offers body search. So there is no HTTP route to this.
 *
 * **Why it is dangerous.** Every other credential in this app is scoped to one
 * account: an instance's Evolution token reaches that instance and Evolution
 * enforces it. A database connection reaches *every* user's messages in *every*
 * instance. It is the same shape of risk as the admin-key fallback that
 * `credentialsForInstance()` deliberately refuses. Three rules keep it contained,
 * and none of them is optional:
 *
 *   1. The role is read-only. Only SELECT on "Message" is granted (README).
 *      Nothing here writes, and nothing here runs DDL — the schema belongs to
 *      Evolution's Prisma migrations.
 *   2. Every query carries `"instanceId" = <this account>`. `searchMessages`
 *      cannot be called without one; a missing id throws rather than widening.
 *   3. Chat scope is a predicate in the SQL, not a filter applied to rows after
 *      they are read. Out-of-scope messages never enter this process.
 *
 * **This is not optional.** It began as a search-only escape hatch, and now both
 * read paths run through it: Evolution's `findMessages` hands back every stored
 * row, and its history import writes duplicates — one message id can hold two or
 * three rows, disagreeing about who sent it. Collapsing them has to happen before
 * `LIMIT`, which means in SQL. Without `NUXT_EVOLUTION_DATABASE_URL` the MCP
 * surface cannot answer at all.
 *
 * **Why the duplicates exist**, since it decides where the fix belongs: 2.3.7
 * dedupes a history import against an in-memory `Set` of `key.id`, rebuilt from
 * the database at the top of each `messaging-history.set`, and the `createMany`
 * behind it sets `skipDuplicates` — which is inert, because the only unique
 * constraint on `Message` is a `@default(cuid())` primary key that can never
 * collide. So nothing in the schema stops a second write, and two batches in
 * flight together, or an import racing live traffic, both insert. Re-pairing an
 * account (`enableFullHistorySync()`) is what puts them in flight.
 */

let client: Sql | undefined

/**
 * Whether this deployment can read messages at all.
 *
 * Checked at startup rather than gating a tool: hiding `read-messages` from a
 * client that has already been told the connector reads WhatsApp is a worse
 * answer than an error saying what is missing.
 */
export function messageDatabaseConfigured(): boolean {
  return Boolean(useRuntimeConfig().evolutionDatabaseUrl)
}

/**
 * Memoized pool, like `pocketbaseAdmin()`. `statement_timeout` matters more than
 * it looks: Evolution ships `@@index([instanceId])` and nothing else, so reading
 * or searching a large account is a sequential scan. A slow query has to surface
 * as an error the caller can report, not as an MCP call that never returns.
 */
function evolutionDb(): Sql {
  if (client) return client

  const url = useRuntimeConfig().evolutionDatabaseUrl
  if (!url) {
    // 500, not 503: a missing variable will not resolve itself on a retry, and
    // saying "temporarily" about a deployment that can never answer sends the
    // operator looking for an outage. Logged because a handled createError is
    // not, and this one is the whole diagnosis.
    console.error(
      '[evolution-db] NUXT_EVOLUTION_DATABASE_URL is not set — read-messages and '
      + 'search-messages cannot answer. See README "Reading and searching messages".',
    )
    throw createError({
      statusCode: 500,
      statusMessage: 'NUXT_EVOLUTION_DATABASE_URL is not set',
    })
  }

  client = postgres(url, {
    max: 3,
    idle_timeout: 30,
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
  })

  return client
}

const STATEMENT_TIMEOUT_MS = 10_000

/**
 * Evolution's own id for this instance — the value `Message.instanceId` is keyed
 * on, and the predicate that keeps one account's search inside that account.
 *
 * `createInstance()` stores it at pairing time, but writes `''` when Evolution's
 * create response did not carry one (`instances.ts`), and an empty id here would
 * mean either a query with no instance predicate at all or an account whose
 * search silently never matches. Neither is acceptable, so an empty value is
 * re-resolved from Evolution and written back, and a failure to resolve is a
 * hard error.
 */
export async function resolveEvolutionInstanceId(instance: AppInstance): Promise<string> {
  if (instance.instance_id) return instance.instance_id

  const evolution = evolutionClientForInstance(instance)

  let rows: Array<{ id?: string, name?: string }> = []
  try {
    rows = await evolution<Array<{ id?: string, name?: string }>>('/instance/fetchInstances')
  }
  catch (error) {
    // A handled createError is never logged by Nitro; without this the operator
    // sees a 503 with nothing behind it.
    console.error('[search] could not reach Evolution to resolve an instance id:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Could not reach Evolution to identify this WhatsApp account',
      cause: error,
    })
  }

  // An instance token scopes fetchInstances to its own instance, but match on
  // name anyway rather than trusting position.
  const id = (Array.isArray(rows) ? rows.find(row => row?.name === instance.name) : undefined)?.id
  if (!id) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This WhatsApp account is not fully provisioned',
    })
  }

  // Best effort. Search works this time either way; the backfill just saves the
  // round trip next time.
  try {
    const pb = await pocketbaseAdmin()
    await pb.collection('instances').update(instance.id, { instance_id: id })
  }
  catch (error) {
    console.error('[search] could not backfill instance_id:', error)
  }

  return id
}

export interface MessageSearchOptions {
  /** Every term must appear in the message body. Already split, not yet escaped. */
  terms: string[]
  /** Restrict to one chat. */
  jid?: string
  /** The only chats this token may see. Omit for an all-chats token. */
  allowedJids?: string[]
  since?: string
  until?: string
  fromMe?: boolean
  /**
   * Match reaction messages too.
   *
   * Defaults to false, which is what this query has always done — before the
   * `reactionMessage` arm below existed a reaction row produced no `body` at all
   * and `body IS NOT NULL` dropped it. Silently, rather than by decision. The
   * default keeps that outcome and makes it a choice.
   */
  includeReactions?: boolean
  limit: number
}

export interface MessageSearchHit {
  jid: string
  id?: string
  fromMe: boolean
  /**
   * Who sent it, unresolved: the sender's JID and the push name stored beside it.
   *
   * Turned into a display name by the caller, for the same reason `mentioned` is
   * — both need the same directory, and the tool is what decides how much of one
   * to pay for. `pushName` is never an answer on its own; see `authorName` in
   * `mentions.ts`.
   */
  sender: { identity?: string, pushName?: string }
  timestamp?: string
  type?: string
  text: string
  /**
   * JIDs this message mentions, for the caller to resolve to names.
   *
   * Left unresolved here on purpose: a hit set spans arbitrarily many chats, and
   * naming a group's members is a live round trip per group. The tool decides how
   * much of that to pay — see `search-messages.ts`.
   */
  mentioned: string[]
}

export async function searchMessages(
  instance: AppInstance,
  options: MessageSearchOptions,
): Promise<{ hits: MessageSearchHit[], truncated: boolean }> {
  const instanceId = await resolveEvolutionInstanceId(instance)
  const sql = evolutionDb()

  const patterns = options.terms.map(term => `%${escapeLike(term)}%`)
  const since = toUnixSeconds(options.since, 'since')
  const until = toUnixSeconds(options.until, 'until')

  // One extra row tells us there were more matches than we returned, for a
  // fraction of the cost of a second COUNT(*) over the same scan.
  const take = options.limit + 1

  let rows: MessageRow[]
  try {
    // `DISTINCT ON (key->>'id')` is what stops one message being reported as two
    // or three matches; `bestNamed` decides which of the duplicate rows survives.
    // It has to run before `LIMIT`, so the dedupe is a CTE and the ordering the
    // caller sees is applied outside it.
    //
    // The `reactionMessage` arm in the COALESCE is what makes an emoji findable
    // at all; the predicate near the bottom is what keeps reactions out by
    // default. That predicate reads the payload rather than `messageType`,
    // because `messageType` is Baileys' `getContentType()` verbatim — the *first*
    // key of the payload that is `conversation` or ends in `Message` — so a
    // reaction arriving alongside a `messageContextInfo` is stored under that
    // type instead, with `message.reactionMessage` sitting right there. The
    // payload is the authority. It costs nothing next to the scan already
    // happening — `@@index([instanceId])` is the only index on
    // `Message`. None of it touches scope: `instanceId`, `jid` and `allowedJids`
    // still bound the query, so an included reaction is only ever one from a
    // chat this token already reaches.
    rows = await sql<MessageRow[]>`
      WITH matched AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", t.body,
               m."contextInfo"->'mentionedJid' AS mentioned,
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            m.message->>'conversation',
            m.message->'extendedTextMessage'->>'text',
            m.message->'imageMessage'->>'caption',
            m.message->'videoMessage'->>'caption',
            m.message->'documentMessage'->>'caption',
            m.message->'documentWithCaptionMessage'->'message'->'documentMessage'->>'caption',
            m.message->>'speechToText',
            m.message->'reactionMessage'->>'text'
          ) AS body
        ) t
        WHERE m."instanceId" = ${instanceId}
          AND t.body IS NOT NULL
          AND t.body ILIKE ALL (${patterns}::text[])
          ${options.jid ? sql`AND m.key->>'remoteJid' = ${options.jid}` : sql``}
          ${options.allowedJids ? sql`AND m.key->>'remoteJid' = ANY(${options.allowedJids}::text[])` : sql``}
          ${since === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${since}`}
          ${until === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${until}`}
          ${options.fromMe === undefined ? sql`` : sql`AND (m.key->>'fromMe')::boolean = ${options.fromMe}`}
          ${options.includeReactions ? sql`` : sql`AND m.message->'reactionMessage' IS NULL`}
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      )
      SELECT key, "pushName", "messageType", "messageTimestamp", body, mentioned
      FROM matched
      ORDER BY "messageTimestamp" DESC, key->>'id' DESC
      LIMIT ${take}
    `
  }
  catch (error) {
    console.error('[search] Evolution database query failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Message search is temporarily unavailable',
      cause: error,
    })
  }

  const truncated = rows.length > options.limit

  return {
    hits: rows.slice(0, options.limit).map(row => ({
      jid: row.key?.remoteJid ?? '',
      id: row.key?.id,
      fromMe: Boolean(row.key?.fromMe),
      sender: senderOf(row),
      timestamp: row.messageTimestamp
        ? new Date(Number(row.messageTimestamp) * 1000).toISOString()
        : undefined,
      type: row.messageType ?? undefined,
      text: row.body,
      mentioned: mentionedJidsOf(row.mentioned),
    })),
    truncated,
  }
}

export interface MessagePageOptions {
  /** The one chat to read. A predicate in the SQL, never a filter over rows read. */
  jid: string
  limit: number
  /** 1-based, counting back from the newest. */
  page: number
  since?: string
  until?: string
  includeReactions?: boolean
}

/**
 * One stored message, still in Evolution's shape.
 *
 * Deliberately not `ChatMessage`: rendering a payload and naming a sender both
 * belong to `chats.ts`, which owns `previewOf` and the name directory. This module
 * reads rows and nothing else.
 */
export interface MessageRecord {
  key: MessageKey | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds — the column is an `Int`, and never null. */
  messageTimestamp: number | null
  message: unknown
  mentioned: string[] | null
}

/**
 * One page of a chat's history, deduplicated, newest first.
 *
 * This replaced `POST /chat/findMessages`, which cannot do the one thing that
 * matters here. Evolution's `Message` table holds two or three rows for a single
 * message across a re-pair, and its endpoint pages with `skip`/`take` over those
 * rows — so a caller asking for 50 messages got 50 *rows*, perhaps 20 distinct
 * ones, and a `total` that counted every copy. Collapsing after the fact cannot
 * fix either: the page boundaries were already drawn in the wrong place. Hence
 * `DISTINCT ON` inside a CTE, with `LIMIT`/`OFFSET` applied to what comes out.
 *
 * Two details in the ordering carry weight. `bestNamed` makes the surviving row of
 * a duplicate set deterministic — otherwise a message's author changes between
 * identical calls. And the outer sort breaks ties on the message id, which
 * Evolution's own `orderBy: { messageTimestamp: 'desc' }` does not: without a
 * tiebreaker, rows sharing a timestamp can appear on two pages or on neither.
 */
export async function listMessagesPage(
  instance: AppInstance,
  options: MessagePageOptions,
): Promise<{ records: MessageRecord[], hasMore: boolean, total?: number }> {
  const instanceId = await resolveEvolutionInstanceId(instance)
  const sql = evolutionDb()

  const since = toUnixSeconds(options.since, 'since')
  const until = toUnixSeconds(options.until, 'until')

  // Same over-fetch trick as `searchMessages`, and `hasMore` still comes from it
  // rather than from `total`, even though `total` is now exact. A count that went
  // wrong upstream must never be able to drive a caller into paging forever.
  const take = options.limit + 1
  const skip = (options.page - 1) * options.limit

  let rows: MessagePageRow[]
  try {
    rows = await sql<MessagePageRow[]>`
      WITH deduped AS (
        SELECT DISTINCT ON (m.key->>'id')
               m.key, m."pushName", m."messageType", m."messageTimestamp", m.message,
               m."contextInfo"->'mentionedJid' AS mentioned,
               ${bestNamed(sql)} AS named, m.id AS "rowId"
        FROM "Message" m
        WHERE m."instanceId" = ${instanceId}
          AND m.key->>'remoteJid' = ${options.jid}
          ${since === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${since}`}
          ${until === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${until}`}
          ${options.includeReactions ? sql`` : sql`AND m.message->'reactionMessage' IS NULL`}
        ORDER BY m.key->>'id', named DESC, m."messageTimestamp" DESC, "rowId"
      )
      SELECT key, "pushName", "messageType", "messageTimestamp", message, mentioned,
             COUNT(*) OVER () AS total
      FROM deduped
      ORDER BY "messageTimestamp" DESC, key->>'id' DESC
      LIMIT ${take} OFFSET ${skip}
    `
  }
  catch (error) {
    // A handled createError is never logged by Nitro, so a 503 would otherwise
    // reach the operator as a response with nothing at all behind it.
    console.error('[read] Evolution database query failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Reading messages is temporarily unavailable',
      cause: error,
    })
  }

  // The window function counts the deduped set, so this is the number of distinct
  // messages in the range — not of rows, and not of the chat. It rides on the
  // returned rows, so a page past the end carries no count rather than a zero:
  // "I did not measure" and "there are none" are different answers.
  const total = Number(rows[0]?.total)

  return {
    records: rows.slice(0, options.limit).map(({ total: _total, ...record }) => record),
    hasMore: rows.length > options.limit,
    total: Number.isFinite(total) ? total : undefined,
  }
}

/**
 * Which row of a duplicate set to keep — as a select-list expression, aliased
 * `named`, because `DISTINCT ON` will not sort on anything the select list does
 * not carry. The same reason `m.id` is selected as `"rowId"`: it is the final
 * tiebreaker and nothing reads it.
 *
 * The copies differ in `pushName`, and only some of them carry a name: a history
 * import can store the sender's own device-locale word for themselves, a bare LID,
 * or a LID JID. Prefer a value that is none of those, so the row that survives is
 * the one with something worth reading — and prefer it *deterministically*, since
 * this decides what an identical second call returns.
 *
 * A last resort, not the mechanism: `authorName` still resolves the sender through
 * the directory first, and refuses a numeric "name" outright.
 */
function bestNamed(sql: Sql) {
  return sql`(m."pushName" IS NOT NULL AND m."pushName" !~ '^[+0-9]' AND m."pushName" NOT LIKE '%@%')`
}

/**
 * The sender's identity as stored, preferring the group participant.
 *
 * Baileys writes `participant` for a group message on both the live and the
 * history path, and `participantAlt` — the same person's other addressing form —
 * only on the live one. Either resolves, because the directory is keyed on the
 * local part. For a 1:1 chat there is no participant and the chat's own JID *is*
 * the sender, which is why `remoteJid` is the fallback rather than nothing.
 */
export function senderOf(row: { key: MessageKey | null, pushName: string | null }): { identity?: string, pushName?: string } {
  return {
    identity: row.key?.participant ?? row.key?.participantAlt ?? row.key?.remoteJid,
    pushName: row.pushName ?? undefined,
  }
}

/**
 * The parts of Baileys' message key this app reads.
 *
 * `participantAlt` and `remoteJidAlt` exist only on rows written by live traffic:
 * history sync hands over the bare protobuf key, which carries exactly
 * `remoteJid`, `fromMe`, `id` and `participant`. So the same conversation yields
 * richer keys for recent messages than for imported ones, and nothing may require
 * the alternate forms to be there.
 */
export interface MessageKey {
  id?: string
  fromMe?: boolean
  remoteJid?: string
  remoteJidAlt?: string
  /** The sender, in a group. Absent in a 1:1 chat. */
  participant?: string
  participantAlt?: string
}

interface MessagePageRow extends MessageRecord {
  /** `COUNT(*) OVER ()`. A bigint, so it arrives as a string. */
  total: string | number
}

interface MessageRow {
  key: MessageKey | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds, not milliseconds — the column is an Int. */
  messageTimestamp: number | null
  body: string
  /**
   * `contextInfo.mentionedJid`, or null where the message mentions nobody.
   *
   * Taken from the `contextInfo` **column** rather than from `message`, because
   * 2.3.7 rewrites `extendedTextMessage` into `conversation` and deletes it on
   * the way in — so the copy nested under `message` is not there to be read. It
   * is a column of `"Message"`, which the read-only search role already selects,
   * so this needs no grant change.
   */
  mentioned: string[] | null
}

/**
 * `%` and `_` are wildcards to ILIKE, so a search for "50%" would otherwise match
 * anything starting "50". Backslash is the default escape character, and has to
 * be escaped first or it would escape the escapes.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

function toUnixSeconds(value: string | undefined, field: string): number | undefined {
  if (!value) return undefined

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw createError({
      statusCode: 400,
      message: `\`${field}\` is not a date I can read: ${value}. Use a format like 2024-03-01 or 2024-03-01T12:00:00Z.`,
    })
  }

  return Math.floor(parsed / 1000)
}
