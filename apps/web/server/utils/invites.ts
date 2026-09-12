import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AppInvitation, AppUser, OrgRole } from './pocketbase'

/**
 * Organization invitations.
 *
 * Link/code based, because this deployment has no SMTP: an admin creates an
 * invitation for an email address, the app returns a one-time URL, and the admin
 * passes it on however they like. The code is therefore a **bearer credential
 * for joining an organization**, and gets the same handling as an MCP token —
 * 32 random bytes, shown exactly once, stored only as a SHA-256 hash, compared
 * in constant time.
 *
 * A bearer credential alone is not enough to join. Every invitation names an
 * email address and acceptance requires the accepting account's own email to
 * match, so a link that leaks into a group chat cannot be redeemed by whoever
 * happens to read it first.
 */

const CODE_PREFIX = 'waorg_'

/** Fourteen days. Long enough to survive a weekend and a forwarded message. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface InviteView {
  id: string
  email: string
  role: OrgRole
  created?: string
  expires_at?: string
  expired: boolean
  invited_by?: string
}

/** Mint a code. The plaintext is returned once and never stored. */
export function mintInviteCode(): { code: string, hash: string } {
  const code = CODE_PREFIX + randomBytes(32).toString('base64url')
  return { code, hash: hashInviteCode(code) }
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function inviteExpiry(): string {
  return new Date(Date.now() + INVITE_TTL_MS).toISOString()
}

/** Emails are stored and compared lower-cased; PocketBase has no transform. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

function isExpired(invite: Pick<AppInvitation, 'expires_at'>): boolean {
  return Boolean(invite.expires_at) && new Date(invite.expires_at!).getTime() <= Date.now()
}

/** What an admin may see about an invitation. Never the code or its hash. */
export function toInviteView(invite: AppInvitation): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    created: invite.created,
    expires_at: invite.expires_at || undefined,
    expired: isExpired(invite),
    invited_by: invite.invited_by || undefined,
  }
}

/** Pending means: not revoked, not accepted, not expired. */
export async function listPendingInvites(orgId: string): Promise<InviteView[]> {
  const pb = await pocketbaseAdmin()
  const rows = await pb.collection('invitations').getFullList<AppInvitation>({
    filter: pb.filter('org = {:org} && revoked != true && accepted_at = ""', { org: orgId }),
    sort: '-created',
  })
  return rows.filter(row => !isExpired(row)).map(toInviteView)
}

/**
 * Create an invitation, replacing any pending one for the same address.
 *
 * "One pending invitation per (org, email)" is enforced here rather than by a
 * partial unique index: such an index would have to encode PocketBase's
 * empty-date (`''`) and boolean (`0`) representations in raw SQL, which is a
 * sharp edge for no gain. Superseding rather than refusing is also the kinder
 * behaviour — an admin re-inviting someone almost always means "the last link
 * got lost", and the old code stops working the moment the new one is made.
 */
export async function createInvite(
  orgId: string,
  invitedBy: AppUser,
  email: string,
  role: OrgRole,
): Promise<{ code: string, invite: InviteView }> {
  const pb = await pocketbaseAdmin()
  const address = normaliseEmail(email)

  const existing = await pb.collection('invitations').getFullList<AppInvitation>({
    filter: pb.filter('org = {:org} && email = {:email} && revoked != true && accepted_at = ""', {
      org: orgId,
      email: address,
    }),
  })
  for (const row of existing) {
    await pb.collection('invitations').update(row.id, { revoked: true })
  }

  const { code, hash } = mintInviteCode()
  const invite = await pb.collection('invitations').create<AppInvitation>({
    org: orgId,
    email: address,
    role,
    code_hash: hash,
    invited_by: invitedBy.id,
    expires_at: inviteExpiry(),
    revoked: false,
  })

  return { code, invite: toInviteView(invite) }
}

/** Why an invitation cannot be used. `undefined` means it can. */
export type InviteProblem = 'not-found' | 'revoked' | 'expired' | 'accepted'

/**
 * Resolve a presented code to its invitation.
 *
 * Returns the row even when it is unusable, with the reason, so the caller can
 * say *why* rather than "no such invitation". That is deliberately more
 * informative than the equivalent MCP token path: whoever holds the code already
 * knows it existed, so distinguishing "expired" from "never existed" leaks
 * nothing and saves a support round-trip.
 *
 * A lookup miss is `not-found`; a backend fault throws. `firstOrNone` is what
 * keeps those apart — see its own comment.
 */
export async function resolveInvite(
  code: string,
): Promise<{ invite?: AppInvitation, problem?: InviteProblem }> {
  if (!code || !code.startsWith(CODE_PREFIX)) return { problem: 'not-found' }

  const pb = await pocketbaseAdmin()
  const hash = hashInviteCode(code)

  const invite = await firstOrNone<AppInvitation>(
    pb,
    'invitations',
    pb.filter('code_hash = {:hash}', { hash }),
  )
  if (!invite) return { problem: 'not-found' }

  // Defence in depth: the lookup already proves equality, but compare explicitly
  // so a future change to the query cannot weaken this.
  const presented = Buffer.from(hash)
  const stored = Buffer.from(invite.code_hash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return { problem: 'not-found' }
  }

  if (invite.revoked) return { invite, problem: 'revoked' }
  if (invite.accepted_at) return { invite, problem: 'accepted' }
  if (isExpired(invite)) return { invite, problem: 'expired' }

  return { invite }
}

/** The message for an unusable invitation, written for the person holding it. */
export function inviteProblemMessage(problem: InviteProblem): string {
  switch (problem) {
    case 'revoked':
      return 'This invitation has been revoked. Ask for a new link.'
    case 'expired':
      return 'This invitation has expired. Ask for a new link.'
    case 'accepted':
      return 'This invitation has already been used.'
    default:
      return 'This invitation link is not valid.'
  }
}

export async function markInviteAccepted(inviteId: string, userId: string): Promise<void> {
  const pb = await pocketbaseAdmin()
  await pb.collection('invitations').update(inviteId, {
    accepted_at: new Date().toISOString(),
    accepted_by: userId,
  })
}
