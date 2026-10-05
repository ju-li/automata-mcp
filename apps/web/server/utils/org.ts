import type { H3Event } from 'h3'
import type {
  AppInstance,
  AppMcpToken,
  AppMembership,
  AppOrganization,
  AppUser,
  OrgRole,
  Db,
} from './app-db'

/**
 * Organizations, roles, and every authorization decision the **web UI** makes.
 *
 * This module is for the session surface only. The MCP surface answers the same
 * question in `mcp-auth.ts` and must keep doing so: the two have entirely
 * separate credential paths, and a single `getCurrentActor(event)` used by both
 * would collapse the split CLAUDE.md calls the central invariant of this
 * codebase. What the two DO share is `authorizesInstance()` below — a pure
 * predicate over already-loaded facts, with no event and no database access, so
 * the rule lives once while each surface loads its own inputs and keeps its own
 * failure semantics (this one throws H3 errors; that one returns `undefined`).
 *
 * ── Authorization answers 404, then 403 ─────────────────────────────────────
 *
 * The old rule was "ownership failures answer 404, so an id cannot be probed".
 * It still holds, and gains a second half now that a connection can be visible
 * to someone who may not act on it:
 *
 *   invisible → 404   another organization's connection, or an unassigned one
 *   visible but forbidden → 403   a member pressing Delete on a connection
 *                                 assigned to them
 *
 * A member already sees their assigned connections on their own dashboard, so
 * 403 there confirms nothing they did not already know, and it is a far better
 * error than a 404 on a page they are looking at.
 */

/** The acting user, resolved to their organization and role. */
export interface Actor {
  user: AppUser
  org: AppOrganization
  role: OrgRole
  membershipId: string
}

/**
 * May this actor reach this connection at all?
 *
 * Pure: no event, no database, no throwing. Shared verbatim with
 * `resolveMcpAuth` so the UI and the MCP surface cannot drift on the rule while
 * disagreeing only in how they load the facts.
 *
 * An admin reaches every connection in their own organization. A member reaches
 * only the ones assigned to them. An instance with no organization at all —
 * which the schema forbids, but a hand-edited row could produce — is reachable
 * by nobody: fail closed rather than let an empty string match an empty string.
 */
export function authorizesInstance(
  actor: { role: OrgRole, orgId: string },
  instanceOrgId: string | undefined,
  hasAssignment: boolean,
): boolean {
  if (!instanceOrgId || !actor.orgId) return false
  if (instanceOrgId !== actor.orgId) return false
  return actor.role === 'admin' || hasAssignment
}

/**
 * The acting user's organization and role.
 *
 * Memoized on `event.context.orgMembership` — deliberately NOT resolved in
 * `server/middleware/session.ts`, which would put a database query on every
 * request including the ones that return early.
 *
 * Throws 403 when the user belongs to no organization. That state is reachable
 * (a record created before this migration, or one whose organization was
 * deleted) and is a dead end rather than an error: `/api/auth/me` reports it
 * without throwing so the client can route somewhere that explains it.
 */
export async function requireMembership(event: H3Event): Promise<Actor> {
  const cached = event.context.orgMembership as Actor | undefined
  if (cached) return cached

  const user = await requireSessionUser(event)
  const actor = await loadActor(user)

  if (!actor) {
    throw createError({
      statusCode: 403,
      statusMessage: 'You are not a member of any organization.',
    })
  }

  event.context.orgMembership = actor
  return actor
}

/**
 * Resolve a user to their organization and role, or `undefined` if they have
 * none. Never throws for "no membership"; a backend fault becomes a 503, for the
 * reason `getSessionUser` gives — a 401 or a silent empty answer during an
 * outage reads as "your account is gone".
 */
export async function loadActor(user: AppUser): Promise<Actor | undefined> {
  let row: { membership_id: string, role: OrgRole, org_id: string, org_name: string, org_created?: string } | undefined
  try {
    const sql = await appDb()
    ;[row] = await sql`
      SELECT m.id AS membership_id, m.role, o.id AS org_id, o.name AS org_name, o.created AS org_created
      FROM app.memberships m JOIN app.organizations o ON o.id = m.org
      WHERE m.user_id = ${user.id}
    `
  }
  catch (error) {
    // A 401 or a silent empty answer during an outage reads as "your account is
    // gone"; log it, because a handled 503 is invisible to Nitro.
    console.error('[org] could not resolve the membership for user', user.id, error)
    throw appDbUnavailable(error)
  }
  if (!row) return undefined

  return {
    user,
    org: { id: row.org_id, name: row.org_name, created: row.org_created },
    role: row.role,
    membershipId: row.membership_id,
  }
}

/** An organization action: renaming it, inviting, changing roles, removing members. */
export async function requireOrgAdmin(event: H3Event): Promise<Actor> {
  const actor = await requireMembership(event)
  if (actor.role !== 'admin') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only an organization admin can do that.',
    })
  }
  return actor
}

/**
 * Create an organization and make one user its admin, inside the caller's
 * transaction — signup's, so an account and its organization exist together or
 * not at all.
 */
export async function createOrganizationFor(tx: Db, user: AppUser, name?: string): Promise<{ org: AppOrganization, membership: AppMembership }> {
  const label = (name ?? '').trim()
    || (user.name ?? '').trim()
    || user.email.split('@')[0]
    || 'Organization'

  const [org] = await tx<AppOrganization[]>`
    INSERT INTO app.organizations (name) VALUES (${label.slice(0, 100)}) RETURNING id, name, created
  `
  const [membership] = await tx<AppMembership[]>`
    INSERT INTO app.memberships (org, user_id, role) VALUES (${org!.id}, ${user.id}, 'admin') RETURNING *
  `
  return { org: org!, membership: membership! }
}

/**
 * The ids of the connections assigned to one member.
 *
 * Admins hold no assignment rows, so this is only ever the member half of the
 * question — never call it without consulting the role first.
 */
export async function listAssignedInstanceIds(userId: string, db?: Db): Promise<string[]> {
  const sql = db ?? await appDb()
  const rows = await sql<{ instance: string }[]>`
    SELECT instance FROM app.instance_assignments WHERE user_id = ${userId}
  `
  return rows.map(row => row.instance)
}

/** The user ids assigned to one connection. Admins are not in here — see `authorizesInstance`. */
export async function listInstanceAssignees(instanceId: string): Promise<string[]> {
  const sql = await appDb()
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM app.instance_assignments WHERE instance = ${instanceId}
  `
  return rows.map(row => row.user_id)
}

/**
 * Give a member the use of one connection.
 *
 * Refuses anyone outside the organization with a 404, the same answer every
 * other cross-organization lookup gives. Assigning an admin is accepted and does
 * nothing: they already reach it, and erroring would make the picker's "select
 * all" behave differently depending on who is in the list.
 */
export async function assignInstance(orgId: string, instanceId: string, userId: string): Promise<void> {
  const member = await requireOrgMember(orgId, userId)
  if (member.role === 'admin') return

  const sql = await appDb()
  await sql`
    INSERT INTO app.instance_assignments (instance, user_id) VALUES (${instanceId}, ${userId})
    ON CONFLICT (instance, user_id) DO NOTHING
  `
}

/**
 * Take it away again — and revoke the tokens that stops working.
 *
 * Without the revoke, those tokens keep rendering as "Active" while answering
 * 401 on the wire, with nothing in the Nitro log to explain it. That is one of
 * the four operations that can silently kill a token; each one deals with the
 * consequence in the same handler that causes it.
 */
export async function unassignInstance(
  orgId: string,
  instanceId: string,
  userId: string,
): Promise<{ revokedTokens: number }> {
  await requireOrgMember(orgId, userId)

  const sql = await appDb()
  return await sql.begin(async (tx) => {
    await tx`DELETE FROM app.instance_assignments WHERE user_id = ${userId} AND instance = ${instanceId}`
    return { revokedTokens: await revokeTokensFor(userId, { instanceId }, tx) }
  })
}

/**
 * How many live tokens an unassignment would revoke, without doing it, so the
 * confirmation can say what it costs rather than asking "are you sure".
 */
export async function countTokensOn(userId: string, instanceId: string): Promise<number> {
  const sql = await appDb()
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.mcp_tokens
    WHERE assigned_to = ${userId} AND instance = ${instanceId} AND NOT revoked
  `
  return row?.count ?? 0
}

async function hasAssignment(userId: string, instanceId: string): Promise<boolean> {
  const sql = await appDb()
  const [row] = await sql`
    SELECT 1 FROM app.instance_assignments WHERE user_id = ${userId} AND instance = ${instanceId}
  `
  return Boolean(row)
}

/**
 * A connection this actor may look at: their organization's, and either theirs
 * to manage or assigned to them.
 *
 * 404 for everything else — another organization's id, an unassigned one, a
 * missing one. The caller cannot tell those apart, which is the point.
 */
export async function requireReadableInstance(
  event: H3Event,
  instanceId: string | undefined,
): Promise<{ instance: AppInstance, actor: Actor }> {
  const actor = await requireMembership(event)

  if (!instanceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const instance = await getRow<AppInstance>('instances', instanceId)
  if (!instance) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  // The assignment read is skipped for an admin: they reach every connection in
  // their organization and hold no rows to find.
  const assigned = actor.role === 'admin'
    ? false
    : await hasAssignment(actor.user.id, instance.id)

  if (!authorizesInstance({ role: actor.role, orgId: actor.org.id }, instance.org, assigned)) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  return { instance, actor }
}

/**
 * Readable *and* of one kind, for a read route that only exists for one kind —
 * the chat list, the table catalogue.
 *
 * 404 for the wrong kind for everyone, admin and member alike: no role is
 * consulted, so there is nothing for the answer to leak. These are reads a
 * member is entitled to: an assigned connection's chats and tables are already
 * reachable through `list-chats` and `list-tables` over MCP, and refusing them
 * in the UI while serving them on the wire would be incoherent.
 */
export async function requireReadableInstanceOfKind(
  event: H3Event,
  instanceId: string | undefined,
  kind: InstanceKind,
): Promise<{ instance: AppInstance, actor: Actor }> {
  const found = await requireReadableInstance(event, instanceId)
  if (instanceKind(found.instance) !== kind) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return found
}

/**
 * Readable and one of several kinds, for a read route more than one kind serves
 * — the chat list and chat lookup, which WhatsApp and Telegram both have.
 *
 * Same rule as `requireReadableInstanceOfKind`: no role is consulted, and any
 * other kind is a 404. Answers the kind so the route can dispatch on it without
 * reading it off the row a second time.
 */
export async function requireReadableInstanceOfKinds<const K extends InstanceKind>(
  event: H3Event,
  instanceId: string | undefined,
  kinds: readonly K[],
): Promise<{ instance: AppInstance, actor: Actor, kind: K }> {
  const found = await requireReadableInstance(event, instanceId)
  const kind = instanceKind(found.instance)
  if (!(kinds as readonly InstanceKind[]).includes(kind)) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return { ...found, kind: kind as K }
}

/**
 * A connection this actor may change: create, delete, reconnect, resync, rotate
 * credentials.
 *
 * Readable first, so an id the actor cannot see stays a 404. Then 403 — they are
 * looking at the connection, so refusing by role tells them nothing new and
 * "you need an admin" is a far more useful answer than "no such thing".
 */
export async function requireManagedInstance(
  event: H3Event,
  instanceId: string | undefined,
): Promise<{ instance: AppInstance, actor: Actor }> {
  const found = await requireReadableInstance(event, instanceId)
  if (found.actor.role !== 'admin') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Only an organization admin can manage a connection.',
    })
  }
  return found
}

/**
 * Management *and* kind, for a route that only makes sense for one kind.
 *
 * Order is readable → role → kind, and the role check must stay in front of the
 * kind check. Kind-first would let a member probing `/tables` distinguish 404
 * (a WhatsApp connection) from 403 (a Postgres one); role-first answers 403 for
 * a member whatever the kind, and the ordering never has to be argued again.
 * For an admin, the wrong kind is a 404 exactly as it was before.
 */
export async function requireManagedInstanceOfKind(
  event: H3Event,
  instanceId: string | undefined,
  kind: InstanceKind,
): Promise<{ instance: AppInstance, actor: Actor }> {
  const found = await requireManagedInstance(event, instanceId)
  if (instanceKind(found.instance) !== kind) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return found
}

/** One row of the member list. */
export interface OrgMember {
  membershipId: string
  userId: string
  email: string
  name?: string
  role: OrgRole
  joined?: string
}

export async function listOrgMembers(orgId: string, db?: Db): Promise<OrgMember[]> {
  const sql = db ?? await appDb()
  return await sql<OrgMember[]>`
    SELECT m.id AS "membershipId", m.user_id AS "userId", u.email, u.name, m.role, m.created AS joined
    FROM app.memberships m JOIN app.users u ON u.id = m.user_id
    WHERE m.org = ${orgId}
    ORDER BY m.created
  `
}

export async function listOrgInstances(orgId: string, db?: Db): Promise<AppInstance[]> {
  const sql = db ?? await appDb()
  return await sql<AppInstance[]>`SELECT * FROM app.instances WHERE org = ${orgId} ORDER BY created`
}

const NO_ADMIN_LEFT = 'That would leave the organization with no admin. Make someone else an admin first.'

/**
 * Lock an organization's memberships for the rest of the transaction and answer
 * how many admins it has.
 *
 * This is the whole last-admin guard. It used to be two checks — a pre-check
 * that lost races and a post-write count that undid the change — because
 * PocketBase had no transaction to hold across a read and a write. Here the
 * `FOR UPDATE` makes two admins demoting each other take turns, so the second
 * one sees the first one's write and is refused; and a refusal rolls back
 * everything before it, which is what keeps a refused operation from having
 * side effects (the first version of `removeMember` revoked an admin's tokens on
 * its way to telling them they could not leave).
 */
async function lockOrgAdmins(tx: Db, orgId: string): Promise<number> {
  const rows = await tx<{ role: OrgRole }[]>`
    SELECT role FROM app.memberships WHERE org = ${orgId} FOR UPDATE
  `
  return rows.filter(row => row.role === 'admin').length
}

function assertAdminSurvives(admins: number, member: OrgMember, nextRole?: OrgRole): void {
  if (member.role !== 'admin' || nextRole === 'admin') return
  if (admins > 1) return
  throw createError({ statusCode: 409, statusMessage: NO_ADMIN_LEFT })
}

/**
 * Change a member's role.
 *
 * Demoting an admin can kill tokens: a member only reaches connections assigned
 * to them, and an admin holds no assignments. Those tokens would keep reading
 * "Active" in the UI while answering 401 on the wire, with nothing in the logs —
 * so they are revoked here, and the caller is expected to have said how many
 * first. `previewRoleChange` reports the count without changing anything.
 */
export async function previewRoleChange(
  orgId: string,
  member: OrgMember,
  role: OrgRole,
): Promise<{ tokensAtRisk: number }> {
  if (role !== 'member' || member.role !== 'admin') return { tokensAtRisk: 0 }

  const sql = await appDb()
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
    WHERE t.assigned_to = ${member.userId} AND NOT t.revoked AND i.org = ${orgId}
      AND NOT EXISTS (
        SELECT 1 FROM app.instance_assignments a WHERE a.instance = i.id AND a.user_id = ${member.userId}
      )
  `
  return { tokensAtRisk: row?.count ?? 0 }
}

/**
 * The last-admin check runs before anything is written, so an absolute refusal
 * never arrives after a confirmable one; the caller checks `previewRoleChange`
 * for the token question only once this would be allowed.
 */
export async function assertAdminSurvivesChange(orgId: string, member: OrgMember, nextRole?: OrgRole): Promise<void> {
  if (member.role !== 'admin' || nextRole === 'admin') return
  const sql = await appDb()
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.memberships WHERE org = ${orgId} AND role = 'admin'
  `
  if ((row?.count ?? 0) > 1) return
  throw createError({ statusCode: 409, statusMessage: NO_ADMIN_LEFT })
}

export async function changeMemberRole(
  orgId: string,
  member: OrgMember,
  role: OrgRole,
): Promise<{ revokedTokens: number }> {
  if (member.role === role) return { revokedTokens: 0 }

  const sql = await appDb()
  return await sql.begin(async (tx) => {
    assertAdminSurvives(await lockOrgAdmins(tx, orgId), member, role)
    await tx`UPDATE app.memberships SET role = ${role}, updated = now() WHERE id = ${member.membershipId}`

    if (role !== 'member') return { revokedTokens: 0 }

    // Revoke only what the demotion actually breaks: tokens on connections they
    // still reach keep working, and an admin re-promoted a minute later would
    // find nothing to explain if we had revoked everything.
    const revoked = await tx`
      UPDATE app.mcp_tokens t SET revoked = true, updated = now()
      FROM app.instances i
      WHERE i.id = t.instance AND i.org = ${orgId}
        AND t.assigned_to = ${member.userId} AND NOT t.revoked
        AND NOT EXISTS (
          SELECT 1 FROM app.instance_assignments a WHERE a.instance = i.id AND a.user_id = ${member.userId}
        )
    `
    return { revokedTokens: revoked.count }
  })
}

/**
 * Remove a member from the organization.
 *
 * One transaction: the last-admin check, the membership, their tokens and their
 * assignments go together or not at all. The ordering arguments this used to
 * need — membership before tokens, so a refusal could not kill tokens; and a
 * crash window between the two, closed at the other end by `acceptInviteInto` —
 * are both answered by the transaction rolling back. `acceptInviteInto` still
 * revokes whatever a joiner holds, as a second line.
 *
 * The account itself is untouched. Removing someone from an organization is not
 * deleting them, and they land on `/no-organization` rather than being signed
 * out from under themselves.
 */
export async function removeMember(orgId: string, member: OrgMember): Promise<{ revokedTokens: number }> {
  const sql = await appDb()
  return await sql.begin(async (tx) => {
    assertAdminSurvives(await lockOrgAdmins(tx, orgId), member)

    await tx`DELETE FROM app.memberships WHERE id = ${member.membershipId}`
    const revokedTokens = await revokeTokensFor(member.userId, {}, tx)
    await tx`DELETE FROM app.instance_assignments WHERE user_id = ${member.userId}`

    return { revokedTokens }
  })
}

/**
 * Move a user into the organization an invitation names.
 *
 * Runs inside the caller's transaction (signup's, or acceptance's together with
 * spending the invitation). It is an **UPDATE** of their existing membership
 * row, never a delete-then-create: `UNIQUE(memberships.user_id)` makes the row
 * the user's single slot, and locking it `FOR UPDATE` is what serialises two
 * acceptances by the same person.
 *
 * Two refusals, both 409, because the alternative in each case is losing
 * something:
 *
 *   - their current organization still owns connections. Those are org-owned, so
 *     leaving would strand them with no member who can reach them. Migrating
 *     them into the inviting organization instead would move a WhatsApp account
 *     and its entire history across a trust boundary on the strength of a link.
 *   - they are the only admin of an organization that still has other members.
 *     Leaving would lock those members out.
 *
 * The now-empty old organization is deleted in the same transaction. It owns no
 * connections — that was the first refusal — so nothing restricts the delete.
 */
export async function acceptInviteInto(
  tx: Db,
  user: AppUser,
  orgId: string,
  role: OrgRole,
): Promise<{ movedFrom?: string }> {
  const [current] = await tx<AppMembership[]>`
    SELECT * FROM app.memberships WHERE user_id = ${user.id} FOR UPDATE
  `

  if (!current) {
    await tx`INSERT INTO app.memberships (org, user_id, role) VALUES (${orgId}, ${user.id}, ${role})`
    return {}
  }

  if (current.org === orgId) {
    // Already here. Idempotent rather than an error: a double-clicked link, or a
    // second copy of the same mail, must not read as a failure.
    return {}
  }

  const previousOrg = current.org

  const owned = await listOrgInstances(previousOrg, tx)
  if (owned.length) {
    const names = owned.map(i => i.label || i.name).join(', ')
    throw createError({
      statusCode: 409,
      statusMessage: `Your current organization still owns ${owned.length} connection(s): ${names}. `
        + 'Delete them, or ask to be invited from a different account, before joining another organization.',
    })
  }

  const others = await tx<{ role: OrgRole }[]>`
    SELECT role FROM app.memberships WHERE org = ${previousOrg} AND user_id <> ${user.id} FOR UPDATE
  `
  if (current.role === 'admin' && others.length && !others.some(row => row.role === 'admin')) {
    throw createError({
      statusCode: 409,
      statusMessage: 'You are the only admin of your current organization. '
        + 'Make someone else an admin there before joining another one.',
    })
  }

  await tx`UPDATE app.memberships SET org = ${orgId}, role = ${role}, updated = now() WHERE id = ${current.id}`

  // Nobody carries live connector tokens across a boundary. In the ordinary case
  // there are none — leaving requires owning no connections, and a token names
  // one — but it is cheap and it makes the rule unconditional.
  await revokeTokensFor(user.id, {}, tx)

  if (!others.length) {
    await tx`DELETE FROM app.organizations WHERE id = ${previousOrg}`
  }

  return { movedFrom: previousOrg }
}

/**
 * One member of this organization, by user id, for a management route.
 *
 * 404 rather than 403 for a user in another organization: an admin has no
 * business learning that some id exists somewhere else.
 */
export async function requireOrgMember(orgId: string, userId: string | undefined): Promise<OrgMember> {
  if (!userId) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const members = await listOrgMembers(orgId)
  const member = members.find(m => m.userId === userId)
  if (!member) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return member
}

/** What an actor may do with one token. */
export type TokenAccess = 'manage' | 'use'

/**
 * Resolve a token id against the acting user.
 *
 * Replaces the old `findOwnedToken`, whose `assigned_to = me` predicate is now
 * wrong in both directions: too narrow, because an admin must be able to edit
 * and revoke a token held by one of their members; and too wide, because it
 * never looked at the connection's organization, so a user who had left could
 * keep managing a token for as long as the row survived.
 *
 * `manage` is an admin of the connection's organization — edit scope, revoke,
 * rotate. `use` is the member the token was issued to — revoke and rotate only,
 * never scope. Everything else is 404, including a member asking about a
 * colleague's token on a connection they share: they cannot see that it exists.
 */
export async function resolveTokenForActor(
  event: H3Event,
  tokenId: string | undefined,
): Promise<{ token: AppMcpToken, instance: AppInstance, actor: Actor, can: TokenAccess }> {
  const actor = await requireMembership(event)

  if (!tokenId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const token = await getRow<AppMcpToken>('mcp_tokens', tokenId)
  const instance = token && await getRow<AppInstance>('instances', token.instance)
  if (!token || !instance) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  if (instance.org && instance.org === actor.org.id) {
    if (actor.role === 'admin') return { token, instance, actor, can: 'manage' }
    if (token.assigned_to === actor.user.id) return { token, instance, actor, can: 'use' }
  }

  throw createError({ statusCode: 404, statusMessage: 'Not found' })
}
