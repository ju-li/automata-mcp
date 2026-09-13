import { z } from 'zod'

const body = z.object({
  code: z.string().min(1),
})

/**
 * Email an invitation link that was just created.
 *
 * The request carries the plaintext code, and presenting it is what authorizes
 * mailing *that* link: the server resolves the code back to its invitation,
 * checks it belongs to this route's id and to the caller's organization, and
 * builds the URL itself. The recipient is the address stored on the row. Nothing
 * the caller sends becomes mail content, so this cannot be turned into a way to
 * mail arbitrary text or arbitrary addresses from this deployment.
 *
 * An invitation belonging to another organization answers 404, like revoking
 * one does. A code that has since been superseded, accepted or expired answers
 * 409 in the holder's own words — mailing a dead link would be worse than
 * refusing.
 *
 * A failed send is a 502 rather than a quiet success: nothing was changed, and
 * the admin still has the link on screen to pass on themselves.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const id = getRouterParam(event, 'id')
  const { code } = await parseBody(event, body)

  const { invite, problem } = await resolveInvite(code)
  if (!id || !invite || invite.id !== id || invite.org !== actor.org.id) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (problem) {
    throw createError({ statusCode: 409, statusMessage: inviteProblemMessage(problem) })
  }

  assertInviteMailAllowed(actor.org.id, invite.email)

  const sent = await sendInviteEmail(event, actor, invite, code)
  if (!sent) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not send the email. The link above still works — send it yourself.',
    })
  }

  return { sent: true }
})
