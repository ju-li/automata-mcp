import { z } from 'zod'

const body = z.object({
  role: z.enum(['admin', 'member']),
  /**
   * Acknowledge the tokens this change will kill. Without it, a demotion that
   * would break tokens is refused with a 409 naming the count, so the admin
   * makes the decision rather than discovering it later from a support ticket.
   */
  revokeTokens: z.boolean().default(false),
})

/**
 * Change a member's role.
 *
 * Demoting an admin is not only a permissions change: an admin reaches every
 * connection in the organization and holds no assignment rows, so a member's
 * tokens on connections they have no assignment for stop authenticating. Those
 * tokens would keep rendering as "Active" while answering 401 on the wire, with
 * nothing in the Nitro log — so they are revoked, and never silently.
 *
 * An admin may demote themselves; what they may not do is leave the
 * organization with no admin at all, which `changeMemberRole` enforces by
 * writing, re-counting, and undoing.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const { role, revokeTokens } = await parseBody(event, body)

  const member = await requireOrgMember(actor.org.id, getRouterParam(event, 'id'))

  // Before anything else, and before the token question: an absolute refusal
  // must not arrive dressed as a confirmable one. Asking "shall I revoke these
  // three tokens?" and then answering "no, actually, you are the last admin"
  // makes the first prompt a lie.
  await assertAdminSurvivesChange(actor.org.id, member, role)

  const { tokensAtRisk } = await previewRoleChange(actor.org.id, member, role)
  if (tokensAtRisk > 0 && !revokeTokens) {
    throw createError({
      statusCode: 409,
      statusMessage: `${member.email} holds ${tokensAtRisk} connector token(s) on connections a member `
        + 'cannot reach. Making them a member will revoke those tokens. Confirm to continue.',
      data: { tokensAtRisk },
    })
  }

  const { revokedTokens } = await changeMemberRole(actor.org.id, member, role)
  return { ok: true, role, revokedTokens }
})
