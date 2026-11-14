import type { AppInstance, AppUser, Db, OrgRole } from './app-db'
import type { Actor } from './org'
import { accountDeletedNoticeEmail } from '../emails/account'

/**
 * Deleting your own account, from the profile page. One file decides what a
 * deletion takes with it and carries it out; the routes only check the password
 * and hand over.
 *
 * Three outcomes, decided by the account's place in its organization:
 *
 *   account           a member, or an admin beside another admin — only the
 *                     account goes. The organization and every connection in it
 *                     stay; connections they created are managed by admins from
 *                     then on (`created_by` is `ON DELETE SET NULL`).
 *   account-and-org   the organization's only member — the organization goes
 *                     too, and every connection it owns first.
 *   blocked           the only admin of an organization that has other members.
 *                     Deleting would leave them with nobody able to manage it,
 *                     the same refusal `acceptInviteInto` and `removeMember`
 *                     give. 409, nothing touched.
 *
 * Rules easy to undo:
 *
 * - **Connections go through `deleteInstance()`, one by one, before any row
 *   in the transaction.** `instances.org` is `ON DELETE RESTRICT` exactly so an
 *   organization cannot be deleted from under a live WhatsApp socket or bridge
 *   session; `deleteInstance` tears those down first and keeps the row when it
 *   cannot. A connection that will not go stops the deletion there, account
 *   intact — the ones already gone were going anyway.
 * - **Decided again under lock.** The preview the browser showed can be stale by
 *   the time the password comes back: a colleague accepts an invitation, the
 *   other admin leaves, a second tab adds a connection. The transaction locks
 *   the organization row (the lock `assertCanAdd` takes when someone joins) and
 *   its memberships, re-reads both, and refuses with 409 when the answer
 *   changed rather than deleting something the confirmation did not name.
 * - **Everything else is the schema's.** Every table naming a user cascades or
 *   sets null (sessions, factors, tokens — so they stop answering — assignments,
 *   pending verifications and resets); every table naming an organization other
 *   than `instances` cascades (memberships, invitations).
 * - **Hosted outbox in the same transaction:** `member.removed` re-syncs a Pro
 *   organization's seats, `org.deleted` cancels its subscription, `user.deleted`
 *   removes the CRM contact. Each event exists exactly when its change does.
 */

export type DeletionMode = 'account' | 'account-and-org' | 'blocked'

export interface DeletionPreview {
  mode: DeletionMode
  /** Absent for an account with no organization. */
  org?: { name: string, role: OrgRole }
  /** The connections deleted with the organization (`account-and-org` only). */
  connections: { id: string, label: string, kind: string }[]
  /** Live connector tokens issued to this account; they stop working. */
  liveTokens: number
  /** Why `blocked`, in words for the person reading it. */
  blockedReason?: string
}

const ONLY_ADMIN = 'You are the only admin of an organization that has other members. '
  + 'Make someone else an admin on the Organization page first, or remove the other members.'

const CHANGED = 'Your organization changed while your account was being deleted. '
  + 'Nothing was deleted; review what will happen and try again.'

interface MemberRow { user_id: string, role: OrgRole }

function modeFor(userId: string, members: MemberRow[]): DeletionMode {
  const mine = members.find(m => m.user_id === userId)
  const others = members.filter(m => m.user_id !== userId)
  if (!others.length) return 'account-and-org'
  if (mine?.role === 'admin' && !others.some(m => m.role === 'admin')) return 'blocked'
  return 'account'
}

function connectionLabel(instance: Pick<AppInstance, 'label' | 'name'>): string {
  return instance.label || instance.name
}

/** What deleting this account would do, without doing any of it. */
export async function previewAccountDeletion(user: AppUser): Promise<DeletionPreview> {
  const actor = await loadActor(user)
  const sql = await appDb()

  const [tokens] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.mcp_tokens WHERE assigned_to = ${user.id} AND NOT revoked
  `
  const liveTokens = tokens?.count ?? 0

  if (!actor) return { mode: 'account', connections: [], liveTokens }

  const members = await sql<MemberRow[]>`SELECT user_id, role FROM app.memberships WHERE org = ${actor.org.id}`
  const mode = modeFor(user.id, members)
  const connections = mode === 'account-and-org'
    ? (await listOrgInstances(actor.org.id)).map(i => ({ id: i.id, label: connectionLabel(i), kind: i.kind }))
    : []

  return {
    mode,
    org: { name: actor.org.name, role: actor.role },
    connections,
    liveTokens,
    ...(mode === 'blocked' ? { blockedReason: ONLY_ADMIN } : {}),
  }
}

/**
 * Delete the account, and its organization when it is the only member. The
 * caller has already checked the current password.
 */
export async function deleteAccount(user: AppUser): Promise<{ orgDeleted: boolean, connectionsDeleted: number }> {
  const actor = await loadActor(user)
  const sql = await appDb()

  let connectionsDeleted = 0
  if (actor) {
    const members = await sql<MemberRow[]>`SELECT user_id, role FROM app.memberships WHERE org = ${actor.org.id}`
    const mode = modeFor(user.id, members)
    if (mode === 'blocked') throw createError({ statusCode: 409, statusMessage: ONLY_ADMIN })
    if (mode === 'account-and-org') connectionsDeleted = await deleteOrgConnections(actor)
  }

  const orgDeleted = await sql.begin(async (tx) => {
    if (!actor) {
      // Re-read under the user's row: an invitation accepted since the preview
      // would otherwise leave a membership to cascade away unannounced.
      const [membership] = await tx`SELECT 1 FROM app.memberships WHERE user_id = ${user.id} FOR UPDATE`
      if (membership) throw createError({ statusCode: 409, statusMessage: CHANGED })
      await deleteUserRow(tx, user, false)
      return false
    }

    const orgId = actor.org.id
    await tx`SELECT 1 FROM app.organizations WHERE id = ${orgId} FOR UPDATE`
    const members = await tx<MemberRow[]>`
      SELECT user_id, role FROM app.memberships WHERE org = ${orgId} FOR UPDATE
    `
    const mine = members.find(m => m.user_id === user.id)
    if (!mine) throw createError({ statusCode: 409, statusMessage: CHANGED })

    const mode = modeFor(user.id, members)
    if (mode === 'blocked') throw createError({ statusCode: 409, statusMessage: ONLY_ADMIN })

    await recordHostedEvent(tx, { type: 'member.removed', org: orgId, userId: user.id, payload: { role: mine.role, reason: 'account_deleted' } })

    if (mode === 'account') {
      await deleteUserRow(tx, user, false)
      return false
    }

    // The only member. Any connection still here was added after the ones
    // above were deleted — never named in the confirmation, so not deleted now.
    // The RESTRICT foreign key would refuse the organization delete anyway;
    // this says why.
    const [remaining] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.instances WHERE org = ${orgId}
    `
    if (remaining?.count) throw createError({ statusCode: 409, statusMessage: CHANGED })

    await deleteUserRow(tx, user, true)
    await tx`DELETE FROM app.organizations WHERE id = ${orgId}`
    await recordHostedEvent(tx, { type: 'org.deleted', org: orgId, userId: user.id, payload: { reason: 'account_deleted' } })
    return true
  })

  return { orgDeleted, connectionsDeleted }
}

async function deleteUserRow(tx: Db, user: AppUser, orgDeleted: boolean): Promise<void> {
  await tx`DELETE FROM app.users WHERE id = ${user.id}`
  await recordHostedEvent(tx, { type: 'user.deleted', userId: user.id, payload: { orgDeleted } })
}

/**
 * Every connection of an organization about to be deleted, through
 * `deleteInstance`. Stops at the first that will not go, naming it, with the
 * account and organization untouched.
 */
async function deleteOrgConnections(actor: Actor): Promise<number> {
  let deleted = 0
  for (const instance of await listOrgInstances(actor.org.id)) {
    try {
      await deleteInstance(instance, {
        event: {
          type: 'connection.deleted',
          org: actor.org.id,
          userId: actor.user.id,
          payload: { id: instance.id, kind: instance.kind, reason: 'account_deleted' },
        },
      })
      deleted++
    }
    catch (error) {
      // Handled errors never reach Nitro's log; this is the only trace.
      console.error(`[account-deletion] could not delete connection ${instance.id} while deleting user ${actor.user.id}:`, error)
      const already = deleted ? ` ${deleted} other connection(s) were already deleted.` : ''
      throw createError({
        statusCode: 503,
        statusMessage: `Could not delete the connection “${connectionLabel(instance)}”, so your account was not deleted.${already} `
          + 'Try again in a few minutes, or delete that connection from its page first.',
      })
    }
  }
  return deleted
}

/**
 * Tell the address its account is gone, best effort, after the commit — the
 * same notice a password change sends, for the same reason: if it was not
 * them, someone had the password.
 */
export function notifyAccountDeleted(email: string, orgDeleted: boolean): void {
  const notice = accountDeletedNoticeEmail({ email, deletedAt: new Date(), orgDeleted }, emailBrand())
  void sendAppEmail({ to: email, ...notice })
}
