/**
 * The organization shapes the UI works with, mirroring `/api/org`.
 *
 * Declared once so the team page, the member table and the invite dialogs cannot
 * drift about what a member or an invitation is — the same argument
 * `useInstances.ts` makes for connections.
 */

export interface OrgMemberRow {
  membershipId: string
  userId: string
  email: string
  name?: string
  role: OrgRole
  joined?: string
}

export interface OrgInviteRow {
  id: string
  email: string
  role: OrgRole
  created?: string
  expires_at?: string
  expired: boolean
}

export interface OrgResponse {
  org: { id: string, name: string }
  role: OrgRole
  members: OrgMemberRow[]
  /** Admin-only: an unaccepted invitation names someone who has not agreed yet. */
  invites?: OrgInviteRow[]
}

/** What to call a role in prose. */
export function describeRole(role: OrgRole): string {
  return role === 'admin' ? 'Admin' : 'Member'
}

/**
 * What a role can do, in one line, for the role picker.
 *
 * Written from the reader's point of view rather than the schema's: "everything"
 * is not a useful description of admin when the question being answered is
 * whether to give someone that power.
 */
export function describeRoleCapabilities(role: OrgRole): string {
  return role === 'admin'
    ? 'Manages the organization, its people, and every connection. Can create connections and issue connector tokens.'
    : 'Uses the connections assigned to them. Can rotate or revoke their own tokens, but not change what a token reaches.'
}
