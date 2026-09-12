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
