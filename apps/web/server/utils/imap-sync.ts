import type { ImapFlow, FetchMessageObject, ListResponse, MessageAddressObject } from 'imapflow'
import type { AppInstance } from './app-db'
import type { ImapTarget } from './imap-client'

/**
 * Copies a mailbox's **headers** into `app.mail_*`, so listing, counting and
 * searching by sender, subject and date are SQL. Bodies and attachments are
 * never synced — they are fetched live when a tool asks (imap-client.ts) — so a
 * row is about a kilobyte whatever the message weighs.
 *
 * Runs in-process from the `imap:sync` task every two minutes, and on demand
 * from the dashboard's "Sync now". Rules easy to undo:
 *
 * - **A lease, claimed by conditional UPDATE, decides who syncs.** Every
 *   replica runs the task; `lease_until < now()` lets exactly one of them in
 *   per mailbox per run, without holding a database connection for the
 *   minutes a backfill takes. The lease outlives `RUN_BUDGET_MS` by a margin,
 *   so a slow run is not joined by a second one halfway through.
 * - **UIDVALIDITY is checked before every folder.** A changed value means the
 *   server renumbered the folder and every stored UID may name a different
 *   message now; the folder's rows are deleted and it starts again. Keeping
 *   them would attach one message's headers to another's body.
 * - **Identity is checked before every run.** New credentials naming another
 *   mailbox delete everything synced from the old one.
 * - **An authentication failure stops the sync** (`auth_failed`) until the
 *   credentials change. Retrying a refused password every two minutes is how
 *   providers lock accounts.
 * - **Every write is an idempotent upsert**, so a run that dies halfway leaves
 *   nothing a later run cannot redo.
 * - **Gmail's All Mail, Junk and Trash are listed but not synced.** All Mail
 *   holds every message again under a second UID; Junk and Trash are not what
 *   anyone means by "my mail". They still appear in `list-mail-folders` with
 *   `synced: false`, so their existence is not hidden.
 */

const LEASE_MS = 10 * 60_000
/** Work per mailbox per run. Whatever is left is the next run's. */
const RUN_BUDGET_MS = 4 * 60_000
/** Headers fetched per folder per run, newest first, while backfilling. */
const BACKFILL_CHUNK = 500
/** New mail fetched per folder per run. A mailbox offline for a month catches up over several runs. */
const NEW_CHUNK = 2000
/** Without CONDSTORE, how many of the newest messages have their flags re-read each run. */
const FLAG_REFRESH = 500
/** Mailboxes synced at once by one process. */
const CONCURRENCY = 4
/** A full UID listing to find expunged messages, every Nth run — and always when counts disagree. */
const EXPUNGE_EVERY = 5

const SKIPPED_SPECIAL_USE = new Set(['\\All', '\\Junk', '\\Trash'])

export interface MailSyncLimits {
  days: number
  max: number
}

export function mailSyncLimits(): MailSyncLimits {
  const config = useRuntimeConfig()
  const days = Number(config.imapBackfillDays)
  const max = Number(config.imapBackfillMax)
  return {
    days: Number.isFinite(days) && days > 0 ? days : 365,
    max: Number.isFinite(max) && max > 0 ? max : 50_000,
  }
}

/** The scheduled task: every IMAP connection, a few at a time. */
export async function runImapSync(): Promise<{ claimed: number, failed: number }> {
  const sql = await appDb()
  const instances = await sql<AppInstance[]>`SELECT * FROM app.instances WHERE kind = 'imap'`

  let claimed = 0
  let failed = 0
  const queue = [...instances]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let instance = queue.shift(); instance; instance = queue.shift()) {
      const outcome = await syncMailbox(instance)
      if (outcome === 'synced' || outcome === 'failed') claimed++
      if (outcome === 'failed') failed++
    }
  })
  await Promise.all(workers)
  return { claimed, failed }
}

/**
 * Start a sync now, without waiting for it. Answers whether one was started —
 * `false` when another run holds the lease, which is already doing the work.
 */
export async function requestImapSync(instance: AppInstance): Promise<boolean> {
  const lease = await claimLease(instance, { ignoreAuthFailure: true })
  if (!lease) return false
  void runClaimed(instance, lease).catch(cause => console.error(`[imap-sync] sync of ${instance.id} failed`, cause))
  return true
}

type SyncOutcome = 'synced' | 'failed' | 'busy' | 'skipped'

export async function syncMailbox(instance: AppInstance): Promise<SyncOutcome> {
  const lease = await claimLease(instance, { ignoreAuthFailure: false })
  if (!lease) return 'busy'
  return await runClaimed(instance, lease)
}

interface Lease {
  runs: number
  target: ImapTarget
}

async function claimLease(instance: AppInstance, options: { ignoreAuthFailure: boolean }): Promise<Lease | undefined> {
  const target = imapTargetOf(instance)
  if (!target) return undefined

  const sql = await appDb()
  await sql`INSERT INTO app.mail_sync_state (instance_id) VALUES (${instance.id}) ON CONFLICT DO NOTHING`
  const [row] = await sql<Array<{ runs: number }>>`
    UPDATE app.mail_sync_state
    SET lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval,
        last_attempt_at = now(),
        runs = runs + 1
    WHERE instance_id = ${instance.id}
      AND lease_until < now()
      ${options.ignoreAuthFailure ? sql`` : sql`AND NOT auth_failed`}
    RETURNING runs`
  return row ? { runs: row.runs, target } : undefined
}

async function runClaimed(instance: AppInstance, lease: Lease): Promise<SyncOutcome> {
  const sql = await appDb()
  const deadline = Date.now() + RUN_BUDGET_MS
  let client: ImapFlow | undefined
  try {
    await resetIfIdentityChanged(instance, lease.target)
    client = await openImap(lease.target)
    await syncFolders(instance, client, lease, deadline)
    await sql`
      UPDATE app.mail_sync_state
      SET last_success_at = now(), last_error_code = NULL, auth_failed = false, lease_until = now()
      WHERE instance_id = ${instance.id}`
    return 'synced'
  }
  catch (cause) {
    const described = (cause as { statusCode?: number })?.statusCode
      ? { code: 'host_refused', auth: false }
      : describeImapError(cause)
    // Logged with the cause: a handled failure is otherwise invisible, and the
    // stored code is all the dashboard shows.
    console.error(`[imap-sync] connection ${instance.id} failed (${described.code})`, cause)
    await sql`
      UPDATE app.mail_sync_state
      SET last_error_code = ${described.code}, last_error_at = now(),
          auth_failed = ${described.auth}, lease_until = now()
      WHERE instance_id = ${instance.id}`.catch(() => {})
    return 'failed'
  }
  finally {
    if (client) await closeImap(client)
  }
}

/**
 * Forget everything synced under a different mailbox. Also called by the
 * credential update, in its own transaction, so the dashboard never shows the
 * old mailbox's folders under the new one's name.
 */
export async function resetIfIdentityChanged(instance: Pick<AppInstance, 'id'>, target: Pick<ImapTarget, 'host' | 'user'>): Promise<void> {
  const identity = imapIdentity(target)
  const sql = await appDb()
  await sql.begin(async (tx) => {
    const [state] = await tx<Array<{ identity: string }>>`
      SELECT identity FROM app.mail_sync_state WHERE instance_id = ${instance.id} FOR UPDATE`
    if (state && state.identity === identity) return
    await tx`DELETE FROM app.mail_folders WHERE instance_id = ${instance.id}`
    await tx`
      INSERT INTO app.mail_sync_state (instance_id, identity) VALUES (${instance.id}, ${identity})
      ON CONFLICT (instance_id) DO UPDATE
      SET identity = EXCLUDED.identity, auth_failed = false, last_error_code = NULL,
          last_success_at = NULL`
  })
}

async function syncFolders(instance: AppInstance, client: ImapFlow, lease: Lease, deadline: number): Promise<void> {
  const sql = await appDb()
  const listed = await client.list()

  const folders = listed.map(folder => ({
    path: folder.path,
    name: folder.name,
    delimiter: folder.delimiter || undefined,
    special_use: folder.specialUse,
    synced: isSyncable(folder),
  }))

  if (folders.length) {
    await sql`
      INSERT INTO app.mail_folders ${sql(folders.map(f => ({ instance_id: instance.id, ...f })))}
      ON CONFLICT (instance_id, path) DO UPDATE
      SET name = EXCLUDED.name, delimiter = EXCLUDED.delimiter,
          special_use = EXCLUDED.special_use, synced = EXCLUDED.synced`
  }
  // A folder the server no longer lists takes its rows with it (cascade).
  await sql`
    DELETE FROM app.mail_folders
    WHERE instance_id = ${instance.id} AND NOT (path = ANY(${folders.map(f => f.path)}::text[]))`
  // A folder that stopped being synced (newly marked Junk) keeps no rows.
  await sql`
    DELETE FROM app.mail_messages m USING app.mail_folders f
    WHERE f.instance_id = ${instance.id} AND m.instance_id = f.instance_id
      AND m.folder_path = f.path AND NOT f.synced`

  // INBOX first, then Sent, then the rest: when the budget runs out, the
  // folders people ask about are the ones that are current.
  const order = (f: { path: string, special_use?: string }) =>
    f.path.toUpperCase() === 'INBOX' ? 0 : f.special_use === '\\Sent' ? 1 : 2
  const toSync = folders.filter(f => f.synced).sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path))

  for (const folder of toSync) {
    if (Date.now() > deadline) break
    try {
      await syncFolder(instance, client, folder.path, lease, deadline)
    }
    catch (cause) {
      // One unreadable folder must not stop the rest. A connection-level
      // failure will fail the next folder too and end the run there.
      if (!client.usable) throw cause
      console.error(`[imap-sync] connection ${instance.id}: a folder failed (${describeImapError(cause).code})`, cause)
    }
  }
}

function isSyncable(folder: ListResponse): boolean {
  if (folder.flags.has('\\Noselect') || folder.flags.has('\\NonExistent')) return false
  return !(folder.specialUse && SKIPPED_SPECIAL_USE.has(folder.specialUse))
}

/** What a run learned about a folder's history; absent fields are left as they were. */
interface BackfillOutcome {
  complete?: boolean
  stopped?: 'days' | 'count' | null
}

interface FolderStateRow {
  uidvalidity?: string
  last_uid: string
  oldest_uid?: string
  highest_modseq?: string
}

async function syncFolder(instance: AppInstance, client: ImapFlow, path: string, lease: Lease, deadline: number): Promise<void> {
  const sql = await appDb()
  const limits = mailSyncLimits()
  const cutoff = new Date(Date.now() - limits.days * 86_400_000)

  const lock = await client.getMailboxLock(path, { readOnly: true, acquireTimeout: 30_000 })
  try {
    const mailbox = client.mailbox
    if (!mailbox) return
    const uidvalidity = String(mailbox.uidValidity)

    const [stored] = await sql<FolderStateRow[]>`
      SELECT uidvalidity::text AS uidvalidity, last_uid::text AS last_uid, oldest_uid::text AS oldest_uid,
             highest_modseq::text AS highest_modseq
      FROM app.mail_folders WHERE instance_id = ${instance.id} AND path = ${path}`
    let state: FolderStateRow = stored ?? { last_uid: '0' }

    if (state.uidvalidity !== undefined && state.uidvalidity !== uidvalidity) {
      console.warn(`[imap-sync] connection ${instance.id}: a folder was renumbered (UIDVALIDITY changed); resyncing it`)
      await sql`DELETE FROM app.mail_messages WHERE instance_id = ${instance.id} AND folder_path = ${path}`
      state = { last_uid: '0' }
      await sql`
        UPDATE app.mail_folders
        SET last_uid = 0, oldest_uid = NULL, highest_modseq = NULL, backfill_complete = false, backfill_stopped = NULL
        WHERE instance_id = ${instance.id} AND path = ${path}`
    }

    const save = (values: Record<string, unknown>) => sql`
      UPDATE app.mail_folders SET ${sql(values)}
      WHERE instance_id = ${instance.id} AND path = ${path}`

    let lastUid = Number(state.last_uid)
    let oldestUid = state.oldest_uid === undefined ? undefined : Number(state.oldest_uid)

    // ── first sight of this folder: the newest chunk inside the age limit ──
    if (oldestUid === undefined) {
      const recent = await uidSearch(client, { since: cutoff })
      const newest = recent.sort((a, b) => b - a).slice(0, BACKFILL_CHUNK)
      await storeMessages(instance, client, path, uidvalidity, newest)
      lastUid = Math.max(newest[0] ?? 0, Number(mailbox.uidNext) - 1, 0)
      oldestUid = newest.length ? newest[newest.length - 1]! : lastUid + 1
      await save({ uidvalidity, last_uid: lastUid, oldest_uid: oldestUid })
    }
    // ── new mail since the last run ──
    else if (Number(mailbox.uidNext) - 1 > lastUid) {
      const fresh = (await uidSearch(client, { uid: `${lastUid + 1}:*` }))
        .filter(uid => uid > lastUid)
        .sort((a, b) => a - b)
        .slice(0, NEW_CHUNK)
      await storeMessages(instance, client, path, uidvalidity, fresh)
      if (fresh.length) lastUid = fresh[fresh.length - 1]!
      // Nothing above lastUid any more (they were expunged before we saw them).
      if (fresh.length < NEW_CHUNK) lastUid = Math.max(lastUid, Number(mailbox.uidNext) - 1)
      await save({ uidvalidity, last_uid: lastUid })
    }

    // ── flag changes ──
    await refreshFlags(instance, client, path, state.highest_modseq, lastUid)

    // ── expunged messages ──
    const [counted] = await sql<Array<{ count: string }>>`
      SELECT count(*) FROM app.mail_messages WHERE instance_id = ${instance.id} AND folder_path = ${path}`
    let storedCount = Number(counted?.count ?? 0)
    if (lease.runs % EXPUNGE_EVERY === 0 || storedCount > mailbox.exists) {
      const present = await uidSearch(client, { all: true })
      const result = await sql`
        DELETE FROM app.mail_messages
        WHERE instance_id = ${instance.id} AND folder_path = ${path}
          AND NOT (uid = ANY(${present}::bigint[]))`
      storedCount -= result.count
    }

    // ── backfill, newest first, inside the limits ──
    //
    // Whether the folder is complete is decided by **date, never by UID
    // position**. UIDs follow arrival order, and arrival is not sending: mail
    // imported or migrated into a folder lands old messages at its highest
    // UIDs. Reaching UID 1 therefore does not mean nothing older was skipped,
    // and a folder that said "complete" over a year of skipped mail would tell
    // the model there is no older mail when there is.
    const finished = async (): Promise<BackfillOutcome> =>
      (await uidSearch(client, { before: cutoff })).length
        ? { complete: false, stopped: 'days' }
        : { complete: true, stopped: null }

    let backfill: BackfillOutcome = {}
    if (oldestUid > 1 && Date.now() < deadline) {
      const older = (await uidSearch(client, { uid: `1:${oldestUid - 1}`, since: cutoff })).sort((a, b) => b - a)
      if (older.length && storedCount >= limits.max) {
        backfill = { complete: false, stopped: 'count' }
      }
      else if (older.length) {
        const chunk = older.slice(0, Math.min(BACKFILL_CHUNK, limits.max - storedCount))
        await storeMessages(instance, client, path, uidvalidity, chunk)
        oldestUid = chunk[chunk.length - 1]!
        await save({ oldest_uid: oldestUid })
      }
      else {
        backfill = await finished()
      }
    }
    else if (oldestUid <= 1) {
      backfill = await finished()
    }

    await save({
      server_messages: mailbox.exists,
      highest_modseq: mailbox.highestModseq === undefined ? null : String(mailbox.highestModseq),
      last_synced_at: new Date(),
      ...(backfill.complete !== undefined && { backfill_complete: backfill.complete }),
      ...(backfill.stopped !== undefined && { backfill_stopped: backfill.stopped }),
    })
  }
  finally {
    lock.release()
  }
}

async function uidSearch(client: ImapFlow, query: Parameters<ImapFlow['search']>[0]): Promise<number[]> {
  const result = await client.search(query, { uid: true })
  return Array.isArray(result) ? result : []
}

/**
 * Re-read flags. With CONDSTORE the server says what changed since the last
 * run; without it, the newest messages are re-read, which is where a person's
 * reading and flagging happens. Older flags may then lag — read state on a
 * year-old message is rarely the question.
 */
async function refreshFlags(
  instance: AppInstance,
  client: ImapFlow,
  path: string,
  highestModseq: string | undefined,
  lastUid: number,
): Promise<void> {
  if (lastUid < 1) return
  const sql = await appDb()
  const updates: Array<{ uid: number, flags: string[] }> = []

  if (client.enabled.has('CONDSTORE') && highestModseq) {
    for await (const message of client.fetch(`1:${lastUid}`, { uid: true, flags: true }, { uid: true, changedSince: BigInt(highestModseq) })) {
      updates.push({ uid: message.uid, flags: [...(message.flags ?? [])] })
    }
  }
  else {
    const rows = await sql<Array<{ uid: string }>>`
      SELECT uid::text AS uid FROM app.mail_messages
      WHERE instance_id = ${instance.id} AND folder_path = ${path}
      ORDER BY uid DESC LIMIT ${FLAG_REFRESH}`
    if (!rows.length) return
    for await (const message of client.fetch(rows.map(r => Number(r.uid)), { uid: true, flags: true }, { uid: true })) {
      updates.push({ uid: message.uid, flags: [...(message.flags ?? [])] })
    }
  }
  if (!updates.length) return

  // IMAP flags are atoms — no spaces — so a space-joined string round-trips.
  await sql`
    UPDATE app.mail_messages m SET flags = string_to_array(v.flags, ' ')
    FROM unnest(${updates.map(u => u.uid)}::bigint[], ${updates.map(u => u.flags.join(' '))}::text[]) AS v(uid, flags)
    WHERE m.instance_id = ${instance.id} AND m.folder_path = ${path} AND m.uid = v.uid`
}

/** Fetch headers for `uids` in batches and upsert them. Bodies are not fetched. */
async function storeMessages(
  instance: AppInstance,
  client: ImapFlow,
  path: string,
  uidvalidity: string,
  uids: number[],
): Promise<void> {
  if (!uids.length) return
  const sql = await appDb()

  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100)
    const rows = []
    for await (const message of client.fetch(batch, {
      uid: true,
      envelope: true,
      flags: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
      headers: ['references'],
    }, { uid: true })) {
      rows.push(toRow(instance.id, path, uidvalidity, message))
    }
    if (!rows.length) continue

    await sql`
      INSERT INTO app.mail_messages ${sql(rows)}
      ON CONFLICT (instance_id, folder_path, uid) DO UPDATE
      SET uidvalidity = EXCLUDED.uidvalidity, message_id = EXCLUDED.message_id,
          in_reply_to = EXCLUDED.in_reply_to, refs = EXCLUDED.refs, subject = EXCLUDED.subject,
          from_addr = EXCLUDED.from_addr, to_addr = EXCLUDED.to_addr, cc_addr = EXCLUDED.cc_addr,
          sent_at = EXCLUDED.sent_at, received_at = EXCLUDED.received_at, flags = EXCLUDED.flags,
          size = EXCLUDED.size, text_part = EXCLUDED.text_part, html_part = EXCLUDED.html_part,
          attachments = EXCLUDED.attachments`
  }
}

function toRow(instanceId: string, path: string, uidvalidity: string, message: FetchMessageObject) {
  const envelope = message.envelope ?? {}
  const parts = messagePartsOf(message.bodyStructure)
  const received = validDate(message.internalDate) ?? validDate(envelope.date) ?? new Date()

  return {
    instance_id: instanceId,
    folder_path: path,
    uidvalidity,
    uid: message.uid,
    message_id: cleanText(envelope.messageId)?.slice(0, 998),
    in_reply_to: cleanText(envelope.inReplyTo)?.slice(0, 998),
    refs: parseReferences(message.headers),
    subject: (cleanText(envelope.subject) ?? '').slice(0, 2000),
    from_addr: addresses(envelope.from),
    to_addr: addresses(envelope.to),
    cc_addr: addresses(envelope.cc),
    sent_at: validDate(envelope.date),
    received_at: received,
    flags: [...(message.flags ?? [])],
    size: message.size,
    text_part: parts.textPart,
    html_part: parts.htmlPart,
    attachments: parts.attachments,
  }
}

/** At most 50 addresses per header: a mass mailing's To line is not worth a megabyte. */
function addresses(list: MessageAddressObject[] | undefined) {
  return (list ?? []).slice(0, 50).map(entry => ({
    ...(cleanText(entry.name) && { name: cleanText(entry.name)!.slice(0, 200) }),
    ...(cleanText(entry.address) && { address: cleanText(entry.address)!.slice(0, 320) }),
  })).filter(entry => entry.name || entry.address)
}

function validDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** `References:` as a list of message ids, capped — threads can carry hundreds. */
function parseReferences(headers: Buffer | undefined): string[] {
  if (!headers) return []
  const ids = headers.toString('utf8').replace(/\0/g, '').match(/<[^<>\s]+>/g) ?? []
  return ids.slice(-50)
}
