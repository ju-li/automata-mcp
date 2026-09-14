import type { H3Event } from 'h3'
import type {
  AppInstance,
  AppInstanceAssignment,
  AppMcpToken,
  AppMembership,
  AppOrganization,
  AppUser,
  OrgRole,
} from './pocketbase'

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
 * Pure: no event, no PocketBase, no throwing. Shared verbatim with
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
 * `server/middleware/session.ts`, which would put a PocketBase query on every
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
  const pb = await pocketbaseAdmin()

  let membership: AppMembership | undefined
  let org: AppOrganization | undefined
  try {
    membership = await firstOrNone<AppMembership>(
      pb,
      'memberships',
      pb.filter('user = {:uid}', { uid: user.id }),
    )
    if (!membership) return undefined

    org = await pb.collection('organizations').getOne<AppOrganization>(membership.org)
  } catch (error) {
    // A membership row pointing at a deleted organization is data corruption,
    // not an auth failure — but it is also unrecoverable for this request, and
    // a 404 here would read as "you are signed out".
    console.error('[org] could not resolve the membership for user', user.id, error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Auth backend unavailable',
      cause: error,
    })
  }

  return { user, org, role: membership.role, membershipId: membership.id }
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

/** Create an organization and make one user its admin. Used by signup and by tests. */
export async function createOrganizationFor(user: AppUser, name?: string): Promise<{ org: AppOrganization, membership: AppMembership }> {
  const pb = await pocketbaseAdmin()

  const label = (name ?? '').trim()
    || (user.name ?? '').trim()
    || user.email.split('@')[0]
    || 'Organization'

  const org = await pb.collection('organizations').create<AppOrganization>({
    name: label.slice(0, 100),
  })

  try {
    const membership = await pb.collection('memberships').create<AppMembership>({
      org: org.id,
      user: user.id,
      role: 'admin',
    })
    return { org, membership }
  } catch (error) {
    // Compensating delete, the same idiom `provisionWhatsappInstance` uses: an
    // organization with no members is unreachable by anyone and would sit in the
    // database forever.
    await pb.collection('organizations').delete(org.id).catch(() => {})
    throw error
  }
}

/**
 * The ids of the connections assigned to one member.
 *
 * Admins hold no assignment rows, so this is only ever the member half of the
 * question — never call it without consulting the role first.
 */
export async function listAssignedInstanceIds(userId: string): Promise<string[]> {
  const pb = await pocketbaseAdmin()
  const rows = await pb.collection('instance_assignments').getFullList<AppInstanceAssignment>({
    filter: pb.filter('user = {:uid}', { uid: userId }),
  })
  return rows.map(row => row.instance)
}

/** The user ids assigned to one connection. Admins are not in here — see `authorizesInstance`. */
export async function listInstanceAssignees(instanceId: string): Promise<string[]> {
  const pb = await pocketbaseAdmin()
  const rows = await pb.collection('instance_assignments').getFullList<AppInstanceAssignment>({
    filter: pb.filter('instance = {:iid}', { iid: instanceId }),
  })
  return rows.map(row => row.user)
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

  const pb = await pocketbaseAdmin()
  const existing = await firstOrNone<AppInstanceAssignment>(
    pb,
    'instance_assignments',
    pb.filter('user = {:uid} && instance = {:iid}', { uid: userId, iid: instanceId }),
  )
  if (existing) return

  await pb.collection('instance_assignments').create({ instance: instanceId, user: userId })
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

  const pb = await pocketbaseAdmin()
  const existing = await firstOrNone<AppInstanceAssignment>(
    pb,
    'instance_assignments',
    pb.filter('user = {:uid} && instance = {:iid}', { uid: userId, iid: instanceId }),
  )
  if (existing) await pb.collection('instance_assignments').delete(existing.id)

  return { revokedTokens: await revokeTokensFor(userId, { instanceId }) }
}

/**
 * How many live tokens an unassignment would revoke, without doing it, so the
 * confirmation can say what it costs rather than asking "are you sure".
 */
export async function countTokensOn(userId: string, instanceId: string): Promise<number> {
  const pb = await pocketbaseAdmin()
  const page = await pb.collection('mcp_tokens').getList(1, 1, {
    filter: pb.filter('assigned_to = {:uid} && instance = {:iid} && revoked != true', {
      uid: userId,
      iid: instanceId,
    }),
  })
  return page.totalItems
}

async function hasAssignment(userId: string, instanceId: string): Promise<boolean> {
  const pb = await pocketbaseAdmin()
  const row = await firstOrNone<AppInstanceAssignment>(
    pb,
    'instance_assignments',
    pb.filter('user = {:uid} && instance = {:iid}', { uid: userId, iid: instanceId }),
  )
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

  const pb = await pocketbaseAdmin()

  let instance: AppInstance
  try {
    instance = await pb.collection('instances').getOne<AppInstance>(instanceId)
  } catch (error) {
    if (isPocketBaseNotFound(error)) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    throw error
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

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const pb = await pocketbaseAdmin()

  const memberships = await pb.collection('memberships').getFullList<AppMembership>({
    filter: pb.filter('org = {:org}', { org: orgId }),
    sort: 'created',
  })
  if (!memberships.length) return []

  // One filtered read rather than one per member, with a binding per id — the
  // admin client must never receive a filter built by concatenating values.
  const params: Record<string, string> = {}
  const clauses = memberships.map((m, index) => {
    params[`u${index}`] = m.user
    return `id = {:u${index}}`
  })
  const users = await pb.collection('users').getFullList<AppUser>({
    filter: pb.filter(clauses.join(' || '), params),
  })
  const byId = new Map(users.map(u => [u.id, u]))

  return memberships.map(m => ({
    membershipId: m.id,
    userId: m.user,
    email: byId.get(m.user)?.email ?? '(unknown)',
    name: byId.get(m.user)?.name,
    role: m.role,
    joined: m.created,
  }))
}

async function countOrgAdmins(orgId: string): Promise<number> {
  const pb = await pocketbaseAdmin()
  const page = await pb.collection('memberships').getList(1, 1, {
    filter: pb.filter('org = {:org} && role = "admin"', { org: orgId }),
  })
  return page.totalItems
}

async function countOrgMembers(orgId: string): Promise<number> {
  const pb = await pocketbaseAdmin()
  const page = await pb.collection('memberships').getList(1, 1, {
    filter: pb.filter('org = {:org}', { org: orgId }),
  })
  return page.totalItems
}

export async function listOrgInstances(orgId: string): Promise<AppInstance[]> {
  const pb = await pocketbaseAdmin()
  return await pb.collection('instances').getFullList<AppInstance>({
    filter: pb.filter('org = {:org}', { org: orgId }),
  })
}

const NO_ADMIN_LEFT = 'That would leave the organization with no admin. Make someone else an admin first.'

/**
 * The last admin cannot be demoted or removed. **Two** checks, and both are
 * needed for different reasons.
 *
 * This one is an ordinary read-modify-write pre-check. It loses a race, so it is
 * not the authority — but it is what makes the ordinary refusal have **no side
 * effects at all**. That is not a nicety: the first version of `removeMember`
 * revoked the member's tokens before discovering it could not remove them, and
 * the compensating action put the membership back but not the tokens. A refused
 * operation that silently kills an admin's connector tokens is worse than the
 * race it was guarding against.
 *
 * Call it before doing anything destructive.
 */
export async function assertAdminSurvivesChange(
  orgId: string,
  member: OrgMember,
  nextRole?: OrgRole,
): Promise<void> {
  if (member.role !== 'admin') return
  if (nextRole === 'admin') return
  if (await countOrgAdmins(orgId) > 1) return

  throw createError({ statusCode: 409, statusMessage: NO_ADMIN_LEFT })
}

/**
 * The authority, and the race guard.
 *
 * There is no transaction to hold across a read and a write, so two admins
 * demoting each other concurrently can both pass the pre-check above and both
 * write, leaving an organization nobody can administer. So the count is taken
 * **after** the write, and the change is undone if it went to zero.
 *
 * A compensating action rather than a lock, the same shape the Evolution
 * provisioning path uses — it turns a permanent lockout into a retry. Do not
 * "simplify" either of these two checks away: the first has no teeth and the
 * second has no manners.
 */
async function assertAdminSurvives(orgId: string, undo: () => Promise<void>): Promise<void> {
  if (await countOrgAdmins(orgId) > 0) return

  await undo()
  throw createError({ statusCode: 409, statusMessage: NO_ADMIN_LEFT })
}

/**
 * Change a member's role.
 *
 * Demoting an admin can kill tokens: a member only reaches connections assigned
 * to them, and an admin holds no assignments. Those tokens would keep reading
 * "Active" in the UI while answering 401 on the wire, with nothing in the logs —
 * so they are revoked here, and the caller is expected to have said how many
 * first. `preview` reports the count without changing anything.
 */
export async function previewRoleChange(
  orgId: string,
  member: OrgMember,
  role: OrgRole,
): Promise<{ tokensAtRisk: number }> {
  if (role !== 'member' || member.role !== 'admin') return { tokensAtRisk: 0 }

  const pb = await pocketbaseAdmin()
  const assigned = new Set(await listAssignedInstanceIds(member.userId))
  const orgInstances = await listOrgInstances(orgId)
  const unreachable = orgInstances.filter(i => !assigned.has(i.id)).map(i => i.id)
  if (!unreachable.length) return { tokensAtRisk: 0 }

  const params: Record<string, string> = { uid: member.userId }
  const clauses = unreachable.map((id, index) => {
    params[`i${index}`] = id
    return `instance = {:i${index}}`
  })
  const page = await pb.collection('mcp_tokens').getList(1, 1, {
    filter: pb.filter(`assigned_to = {:uid} && revoked != true && (${clauses.join(' || ')})`, params),
  })
  return { tokensAtRisk: page.totalItems }
}

export async function changeMemberRole(
  orgId: string,
  member: OrgMember,
  role: OrgRole,
): Promise<{ revokedTokens: number }> {
  const pb = await pocketbaseAdmin()
  if (member.role === role) return { revokedTokens: 0 }

  await assertAdminSurvivesChange(orgId, member, role)
  await pb.collection('memberships').update(member.membershipId, { role })
  await assertAdminSurvives(orgId, async () => {
    await pb.collection('memberships').update(member.membershipId, { role: member.role })
  })

  if (role !== 'member') return { revokedTokens: 0 }

  // Revoke only what the demotion actually breaks: tokens on connections they
  // still reach keep working, and an admin re-promoted a minute later would find
  // nothing to explain if we had revoked everything.
  const assigned = new Set(await listAssignedInstanceIds(member.userId))
  const orgInstances = await listOrgInstances(orgId)

  let revoked = 0
  for (const instance of orgInstances) {
    if (assigned.has(instance.id)) continue
    revoked += await revokeTokensFor(member.userId, { instanceId: instance.id })
  }
  return { revokedTokens: revoked }
}

/**
 * Remove a member from the organization.
 *
 * **The membership goes first, and the tokens only once the removal has stuck.**
 * The obvious order is the other way round — revoke first, so that dying halfway
 * over-revokes rather than under-revokes — and it is wrong here, because this
 * operation can be *refused*. Revoking before the last-admin guard has had its
 * say means a 409 that silently killed an admin's connector tokens on its way to
 * saying no, and the compensating action restores the membership but cannot
 * un-revoke anything.
 *
 * What the chosen order risks instead is a crash between the delete and the
 * revoke, leaving tokens marked live that no longer authenticate — harmless on
 * its own, since `resolveMcpAuth` refuses them the moment the membership is
 * gone, and closed at the other end by `acceptInviteInto`, which revokes
 * whatever a joiner still holds.
 *
 * The account itself is untouched. Removing someone from an organization is not
 * deleting them, and they land on `/no-organization` rather than being signed
 * out from under themselves.
 */
export async function removeMember(orgId: string, member: OrgMember): Promise<{ revokedTokens: number }> {
  const pb = await pocketbaseAdmin()

  await assertAdminSurvivesChange(orgId, member)

  await pb.collection('memberships').delete(member.membershipId)
  await assertAdminSurvives(orgId, async () => {
    // Recreate the row rather than "un-delete" it: the id changes, but the
    // organization keeps an admin, which is the invariant being defended.
    await pb.collection('memberships').create({ org: orgId, user: member.userId, role: member.role })
  })

  const revokedTokens = await revokeTokensFor(member.userId)

  const assignments = await pb.collection('instance_assignments').getFullList<AppInstanceAssignment>({
    filter: pb.filter('user = {:uid}', { uid: member.userId }),
  })
  for (const row of assignments) {
    await pb.collection('instance_assignments').delete(row.id)
  }

  return { revokedTokens }
}

/**
 * Move a user into the organization an invitation names.
 *
 * This is an **UPDATE** of their existing membership row, never a
 * delete-then-create. `UNIQUE(memberships.user)` makes the row the user's single
 * slot, so one write is atomic, trips no index, and leaves no window in which
 * they belong to nothing — which matters because there is no transaction to
 * wrap the alternative in.
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
 * The now-empty old organization is deleted afterwards, best-effort: a stranded
 * empty organization is harmless, and a failed cleanup must not fail the join.
 */
export async function acceptInviteInto(
  user: AppUser,
  orgId: string,
  role: OrgRole,
): Promise<{ movedFrom?: string }> {
  const pb = await pocketbaseAdmin()

  const current = await firstOrNone<AppMembership>(
    pb,
    'memberships',
    pb.filter('user = {:uid}', { uid: user.id }),
  )

  if (!current) {
    await pb.collection('memberships').create({ org: orgId, user: user.id, role })
    return {}
  }

  if (current.org === orgId) {
    // Already here. Idempotent rather than an error: a double-clicked link, or a
    // second copy of the same mail, must not read as a failure.
    return {}
  }

  const previousOrg = current.org

  const owned = await listOrgInstances(previousOrg)
  if (owned.length) {
    const names = owned.map(i => i.label || i.name).join(', ')
    throw createError({
      statusCode: 409,
      statusMessage: `Your current organization still owns ${owned.length} connection(s): ${names}. `
        + 'Delete them, or ask to be invited from a different account, before joining another organization.',
    })
  }

  if (current.role === 'admin' && await countOrgAdmins(previousOrg) === 1 && await countOrgMembers(previousOrg) > 1) {
    throw createError({
      statusCode: 409,
      statusMessage: 'You are the only admin of your current organization. '
        + 'Make someone else an admin there before joining another one.',
    })
  }

  await pb.collection('memberships').update(current.id, { org: orgId, role })

  // Nobody carries live connector tokens across a boundary. In the ordinary case
  // there are none — leaving requires owning no connections, and a token names
  // one. It closes the narrow window `removeMember` documents, where a crash
  // between dropping a membership and revoking could otherwise let old tokens
  // come back to life if the same person were re-invited.
  await revokeTokensFor(user.id)

  if (await countOrgMembers(previousOrg) === 0) {
    await pb.collection('organizations').delete(previousOrg).catch(() => {})
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

  const pb = await pocketbaseAdmin()

  let token: AppMcpToken
  let instance: AppInstance
  try {
    token = await pb.collection('mcp_tokens').getOne<AppMcpToken>(tokenId)
    instance = await pb.collection('instances').getOne<AppInstance>(token.instance)
  } catch (error) {
    if (isPocketBaseNotFound(error)) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    throw error
  }

  if (instance.org && instance.org === actor.org.id) {
    if (actor.role === 'admin') return { token, instance, actor, can: 'manage' }
    if (token.assigned_to === actor.user.id) return { token, instance, actor, can: 'use' }
  }

  throw createError({ statusCode: 404, statusMessage: 'Not found' })
}
