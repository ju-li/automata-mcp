import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { AppInstance } from './pocketbase'

/**
 * Read-only access to Evolution's own Postgres, for message search and nothing
 * else.
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
 * Search is optional. With no `NUXT_EVOLUTION_DATABASE_URL` the tool that uses
 * this is not registered at all, rather than failing when called.
 */

let client: Sql | undefined

export function messageSearchConfigured(): boolean {
  return Boolean(useRuntimeConfig().evolutionDatabaseUrl)
}

/**
 * Memoized pool, like `pocketbaseAdmin()`. `statement_timeout` matters more than
 * it looks: Evolution ships `@@index([instanceId])` and nothing else, so a search
 * over a large account is a sequential scan. A slow query has to surface as an
 * error the caller can report, not as an MCP call that never returns.
 */
function evolutionDb(): Sql {
  if (client) return client

  const url = useRuntimeConfig().evolutionDatabaseUrl
  if (!url) {
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
  after?: string
  before?: string
  fromMe?: boolean
  limit: number
}

export interface MessageSearchHit {
  jid: string
  id?: string
  fromMe: boolean
  author?: string
  timestamp?: string
  type?: string
  text: string
}

export async function searchMessages(
  instance: AppInstance,
  options: MessageSearchOptions,
): Promise<{ hits: MessageSearchHit[], truncated: boolean }> {
  const instanceId = await resolveEvolutionInstanceId(instance)
  const sql = evolutionDb()

  const patterns = options.terms.map(term => `%${escapeLike(term)}%`)
  const after = toUnixSeconds(options.after, 'after')
  const before = toUnixSeconds(options.before, 'before')

  // One extra row tells us there were more matches than we returned, for a
  // fraction of the cost of a second COUNT(*) over the same scan.
  const take = options.limit + 1

  let rows: MessageRow[]
  try {
    rows = await sql<MessageRow[]>`
      SELECT m.id, m.key, m."pushName", m."messageType", m."messageTimestamp", t.body
      FROM "Message" m
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          m.message->>'conversation',
          m.message->'extendedTextMessage'->>'text',
          m.message->'imageMessage'->>'caption',
          m.message->'videoMessage'->>'caption',
          m.message->'documentMessage'->>'caption',
          m.message->'documentWithCaptionMessage'->'message'->'documentMessage'->>'caption',
          m.message->>'speechToText'
        ) AS body
      ) t
      WHERE m."instanceId" = ${instanceId}
        AND t.body IS NOT NULL
        AND t.body ILIKE ALL (${patterns}::text[])
        ${options.jid ? sql`AND m.key->>'remoteJid' = ${options.jid}` : sql``}
        ${options.allowedJids ? sql`AND m.key->>'remoteJid' = ANY(${options.allowedJids}::text[])` : sql``}
        ${after === undefined ? sql`` : sql`AND m."messageTimestamp" >= ${after}`}
        ${before === undefined ? sql`` : sql`AND m."messageTimestamp" <= ${before}`}
        ${options.fromMe === undefined ? sql`` : sql`AND (m.key->>'fromMe')::boolean = ${options.fromMe}`}
      ORDER BY m."messageTimestamp" DESC
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
      author: row.pushName ?? undefined,
      timestamp: row.messageTimestamp
        ? new Date(Number(row.messageTimestamp) * 1000).toISOString()
        : undefined,
      type: row.messageType ?? undefined,
      text: row.body,
    })),
    truncated,
  }
}

interface MessageRow {
  id: string
  key: { id?: string, fromMe?: boolean, remoteJid?: string } | null
  pushName: string | null
  messageType: string | null
  /** Unix seconds, not milliseconds — the column is an Int. */
  messageTimestamp: number | null
  body: string
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
      message: `\`${field}\` is not a date I can read. Use an ISO-8601 date like 2026-08-01 or 2026-08-01T12:00:00Z.`,
    })
  }

  return Math.floor(parsed / 1000)
}
