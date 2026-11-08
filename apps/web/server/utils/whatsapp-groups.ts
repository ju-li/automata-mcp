/**
 * Last-known WhatsApp group subjects and sizes, kept in `app.whatsapp_groups`,
 * and when they were last fetched from WhatsApp, kept in
 * `app.whatsapp_group_scans`.
 *
 * The only file that reads or writes either table. It backs the in-memory group
 * cache in `chats.ts` (`groupsFor`). The source is still Evolution's
 * `fetchAllGroups`, but that is now a rare event rather than a cache refresh:
 *
 * **One scan costs about two WhatsApp queries per group.** Evolution 2.3.7's
 * `fetchAllGroups` calls Baileys' `groupFetchAllParticipating()`, which emits
 * `groups.update` for every group; Evolution answers that event with a
 * `groupMetadata` query per group, all at once, and then fetches each group's
 * picture, one at a time. On a 47-group account WhatsApp answered every scan
 * with a burst of `rate-overlimit` (429) — and repeated rate-limit hits are
 * the kind of traffic that gets a number restricted. So:
 *
 *   - a scan runs at most once per `GROUP_SCAN_INTERVAL_MS` per account, across
 *     every replica, and only by the one that claims the lease
 *     (`claimGroupScan`);
 *   - a failed scan holds every replica off for a back-off that doubles with
 *     each consecutive failure (`groupScanBackoffMs`: 1 h, 2 h, 4 h … capped at
 *     a day) and resets on success, so an account whose scan can never finish
 *     stops costing WhatsApp a full scan every hour (#131);
 *   - the request waits as long as Node's fetch can (`GROUP_SCAN_TIMEOUT_MS`):
 *     Evolution carries on after we give up, so a timeout that is too short
 *     wastes the whole scan's WhatsApp queries rather than saving them;
 *   - in between, everyone names groups from the stored rows.
 *
 * Staleness rule, stated once here and relied on by `chats.ts`:
 *
 *   1. A successful scan replaces the account's rows exactly
 *      (`replaceStoredGroups`): a group missing from it is deleted, since the
 *      account left it. A failed scan writes nothing but `failed_at` and the
 *      failure count.
 *   2. A group joined or renamed since the last scan keeps its old subject, or
 *      falls back to the contact name and then the bare id, for up to the scan
 *      interval.
 *   3. Rows older than 30 days are not used — a subject we last saw is fine,
 *      one from months ago is closer to a guess.
 *   4. Logging out does not clear the rows. Re-pairing and resync both log out,
 *      and a group's subject belongs to the group, not to the account; groups a
 *      newly paired number is not in fall away under rule 1.
 *
 * Naming is best-effort, so nothing here throws: a failed read answers
 * `undefined`, a failed claim answers "don't scan", and a failed write is
 * logged.
 */

/** How often an account's groups are fetched from WhatsApp, at most. */
export const GROUP_SCAN_INTERVAL_MS = 6 * 60 * 60_000
/** How long every replica waits after the first failed scan in a row; doubles with each further one. */
export const GROUP_SCAN_FAILURE_BACKOFF_MS = 60 * 60_000
/** The longest wait after failures, however many. */
export const GROUP_SCAN_MAX_FAILURE_BACKOFF_MS = 24 * 60 * 60_000
/**
 * The `fetchAllGroups` request timeout: as long as a request can wait here.
 * Evolution answers only once every group's picture is fetched, so no header
 * arrives before the whole scan is done, and Node's fetch (undici's default
 * dispatcher, `headersTimeout`) abandons a request with no headers after 300 s
 * whatever timeout we pass. Going past it needs an undici `Agent`, and undici
 * is not a direct dependency.
 *
 * It was 120 s. A 289-group account finished inside that once, then timed out
 * six times in a row (Evolution logging `rate-overlimit` on group metadata
 * throughout), and a 207-group account never finished (#131). Evolution keeps
 * going after we give up — WhatsApp is queried either way — so the longer wait
 * costs a held socket, not queries. An account that still cannot finish is
 * held off by the growing back-off instead.
 */
export const GROUP_SCAN_TIMEOUT_MS = 290_000
/** Longer than the timeout, so a scan still running is never claimed twice. */
const GROUP_SCAN_LEASE_MS = GROUP_SCAN_TIMEOUT_MS + 60_000
/** Failures past this many no longer lengthen the back-off; keeps the arithmetic finite. */
const GROUP_SCAN_FAILURE_EXPONENT_CAP = 10
/** Stored rows older than this are not used to name anything. */
export const GROUP_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/**
 * How long every replica waits after `failures` consecutive failed scans:
 * 1 h after the first, then 2 h, 4 h … up to `GROUP_SCAN_MAX_FAILURE_BACKOFF_MS`.
 * `claimGroupScan` applies the same rule in SQL; this copy is for logging.
 */
export function groupScanBackoffMs(failures: number): number {
  const doublings = Math.min(Math.max(failures - 1, 0), GROUP_SCAN_FAILURE_EXPONENT_CAP)
  return Math.min(GROUP_SCAN_FAILURE_BACKOFF_MS * 2 ** doublings, GROUP_SCAN_MAX_FAILURE_BACKOFF_MS)
}

export interface StoredGroup {
  subject?: string
  size?: number
}

/**
 * The account's stored groups, or `undefined` when there are none younger than
 * `GROUP_MAX_AGE_MS` or the read failed.
 *
 * "None" and "failed" collapse on purpose: either way the caller has nothing to
 * name groups with and falls back to what it does today.
 */
export async function readStoredGroups(instanceId: string): Promise<Map<string, StoredGroup> | undefined> {
  try {
    const sql = await appDb()
    const rows = await sql<Array<{ jid: string, subject?: string, size?: number }>>`
      SELECT jid, subject, size
      FROM app.whatsapp_groups
      WHERE instance_id = ${instanceId}
        AND fetched_at > now() - make_interval(secs => ${GROUP_MAX_AGE_MS / 1000})`

    if (!rows.length) return undefined

    return new Map(rows.map(row => [row.jid, { subject: row.subject, size: row.size }]))
  }
  catch (error) {
    console.warn(`[groups] could not read stored groups for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}

/**
 * Whether this process may scan the account's groups now — and if so, it holds
 * the lease until `replaceStoredGroups` or `recordGroupScanFailure` releases it,
 * or `GROUP_SCAN_LEASE_MS` passes.
 *
 * A conditional UPDATE, so of any number of replicas reading at once exactly one
 * wins, and no database connection is held across the scan. A failure to ask
 * answers `false`: when we cannot coordinate, we do not query WhatsApp.
 *
 * The back-off condition is `groupScanBackoffMs` in SQL, so it is decided on
 * the row every replica shares.
 */
export async function claimGroupScan(instanceId: string): Promise<boolean> {
  try {
    const sql = await appDb()
    await sql`INSERT INTO app.whatsapp_group_scans (instance_id) VALUES (${instanceId}) ON CONFLICT DO NOTHING`
    const claimed = await sql`
      UPDATE app.whatsapp_group_scans
      SET lease_until = now() + make_interval(secs => ${GROUP_SCAN_LEASE_MS / 1000})
      WHERE instance_id = ${instanceId}
        AND (lease_until IS NULL OR lease_until < now())
        AND (scanned_at IS NULL OR scanned_at < now() - make_interval(secs => ${GROUP_SCAN_INTERVAL_MS / 1000}))
        AND (
          failed_at IS NULL OR failures = 0
          OR failed_at < now() - make_interval(secs => LEAST(
            ${GROUP_SCAN_FAILURE_BACKOFF_MS / 1000}::float8
              * power(2, LEAST(GREATEST(failures - 1, 0), ${GROUP_SCAN_FAILURE_EXPONENT_CAP})),
            ${GROUP_SCAN_MAX_FAILURE_BACKOFF_MS / 1000}::float8)))
      RETURNING 1`
    return claimed.length > 0
  }
  catch (error) {
    console.warn(`[groups] could not claim a group scan for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Record a failed scan: one more failure in a row, and every replica now waits
 * out the back-off it sets. Releases the lease.
 *
 * Answers that back-off for the log, or `undefined` when the write failed — in
 * which case the lease simply runs out and the next claim retries.
 */
export async function recordGroupScanFailure(instanceId: string): Promise<number | undefined> {
  try {
    const sql = await appDb()
    const rows = await sql<Array<{ failures: number }>>`
      UPDATE app.whatsapp_group_scans
      SET failed_at = now(), failures = failures + 1, lease_until = NULL
      WHERE instance_id = ${instanceId}
      RETURNING failures`
    return rows[0] ? groupScanBackoffMs(rows[0].failures) : undefined
  }
  catch (error) {
    console.warn(`[groups] could not record a failed group scan for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}

/**
 * Make the stored rows exactly `groups` — upsert every one, delete the rest —
 * and record the scan as done, resetting the failure count and releasing the
 * lease.
 *
 * One transaction, so a reader never sees a half-replaced list. An empty map
 * deletes every row — an account really can be in no groups.
 *
 * A foreign-key violation here means the connection was deleted while its
 * refresh was in flight; there is nothing left to store against, so it is
 * logged like any other failure and dropped.
 */
export async function replaceStoredGroups(instanceId: string, groups: Map<string, StoredGroup>): Promise<void> {
  const rows = [...groups].map(([jid, group]) => ({
    instance_id: instanceId,
    jid,
    subject: group.subject,
    size: group.size !== undefined && Number.isInteger(group.size) && group.size >= 0 ? group.size : undefined,
  }))

  try {
    const sql = await appDb()
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM app.whatsapp_groups
        WHERE instance_id = ${instanceId}
          AND NOT (jid = ANY(${rows.map(row => row.jid)}::text[]))`

      await tx`
        UPDATE app.whatsapp_group_scans
        SET scanned_at = now(), failures = 0, lease_until = NULL
        WHERE instance_id = ${instanceId}`

      if (!rows.length) return

      await tx`
        INSERT INTO app.whatsapp_groups ${tx(rows, 'instance_id', 'jid', 'subject', 'size')}
        ON CONFLICT (instance_id, jid) DO UPDATE
          SET subject = EXCLUDED.subject, size = EXCLUDED.size, fetched_at = now()`
    })
  }
  catch (error) {
    console.warn(`[groups] could not store groups for connection ${instanceId}:`, error instanceof Error ? error.message : error)
  }
}
