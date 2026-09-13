import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
})

/**
 * Invite someone to this organization.
 *
 * The plaintext code is in this response and nowhere else — only its SHA-256
 * hash is stored, exactly like an MCP token. The UI must show it once and say
 * so; emailing it is a separate request (`[id]/email.post.ts`) the admin makes
 * from that same dialog, so a mail failure never costs them the link.
 *
 * Inviting an address that already has a pending invitation supersedes it rather
 * than failing: re-inviting almost always means "the last link got lost", and
 * the old code stops working the moment the new one exists.
 *
 * Deliberately not checked here: whether that email already has an account. An
 * answer either way would turn this route into an account-existence oracle for
 * any admin of any organization, and the accept flow handles both cases anyway.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const { email, role } = await parseBody(event, body)

  const { code, invite } = await createInvite(actor.org.id, actor.user, email, role)

  return {
    invite,
    code,
    url: inviteUrl(event, code),
  }
})
