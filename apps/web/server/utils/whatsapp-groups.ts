/**
 * Last-known WhatsApp group subjects and sizes, kept in `app.whatsapp_groups`.
 *
 * The only file that reads or writes the table. It backs the in-memory group
 * cache in `chats.ts` (`groupsFor`), whose source of truth is still Evolution's
 * `fetchAllGroups`: that lookup needs a live socket and takes a minute on a
 * busy account, so a process that just started, a second replica, or an
 * account that is offline would otherwise have no subjects at all.
 *
 * Staleness rule, stated once here and relied on by `chats.ts`:
 *
 *   1. A successful refresh replaces the account's rows exactly
 *      (`replaceStoredGroups`): a group missing from it is deleted, since the
 *      account left it. A failed refresh writes nothing.
 *   2. Readers pass a maximum age. Seeding a cold cache ignores rows older than
 *      30 days — a subject we last saw is fine, one from months ago is closer to
 *      a guess — and naming falls back to contacts and then the bare id.
 *   3. Logging out does not clear the rows. Re-pairing and resync both log out,
 *      and a group's subject belongs to the group, not to the account; groups a
 *      newly paired number is not in fall away under rule 1.
 *
 * Naming is best-effort, so neither function throws: a failed read answers
 * `undefined` and a failed write is logged.
 */

export interface StoredGroup {
  subject?: string
  size?: number
}

/**
 * The account's stored groups, or `undefined` when there are none written
 * within `maxAgeMs` or the read failed.
 *
 * "None" and "failed" collapse on purpose: either way the caller has nothing to
 * name groups with and falls back to what it does today.
 */
export async function readStoredGroups(instanceId: string, maxAgeMs: number): Promise<Map<string, StoredGroup> | undefined> {
  try {
    const sql = await appDb()
    const rows = await sql<Array<{ jid: string, subject?: string, size?: number }>>`
      SELECT jid, subject, size
      FROM app.whatsapp_groups
      WHERE instance_id = ${instanceId}
        AND fetched_at > now() - make_interval(secs => ${maxAgeMs / 1000})`

    if (!rows.length) return undefined

    return new Map(rows.map(row => [row.jid, { subject: row.subject, size: row.size }]))
  }
  catch (error) {
    console.warn(`[groups] could not read stored groups for connection ${instanceId}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}

/**
 * Make the stored rows exactly `groups`: upsert every one, delete the rest.
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
