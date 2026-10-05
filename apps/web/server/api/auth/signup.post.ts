import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  name: z.string().max(100).optional(),
  /** Signing up through an invitation link joins that organization instead. */
  invite: z.string().max(200).optional(),
})

/**
 * Sign up, and land in an organization.
 *
 * The account and its organization (or its place in the inviting one) are
 * written in **one transaction**, which is what makes "every user has a
 * membership" an invariant rather than a hope: there is no window, and no
 * compensating delete, in which an account exists with nowhere to go. There is
 * deliberately no lazy self-heal elsewhere — creating an organization for
 * whoever turns up without one would hand a free one to anyone, and silently
 * resurrect a user an admin had just removed.
 *
 * Signing up **through an invitation** joins that organization instead, and
 * creates no solo organization. The invitation is resolved and its email checked
 * BEFORE anything is written, so a bad code costs nothing.
 */
export default defineEventHandler(async (event) => {
  const { email, password, name, invite: code } = await parseBody(event, body)

  const invited = code ? await resolveInvite(code) : undefined
  if (invited) {
    if (invited.problem || !invited.invite) {
      throw createError({
        statusCode: invited.problem === 'not-found' || !invited.problem ? 404 : 422,
        statusMessage: inviteProblemMessage(invited.problem ?? 'not-found'),
      })
    }
    if (normaliseEmail(email) !== invited.invite.email) {
      throw createError({
        statusCode: 403,
        statusMessage: `This invitation is for ${invited.invite.email}. Sign up with that address to accept it.`,
      })
    }
  }

  const passwordHash = await hashPassword(password)
  const sql = await appDb()

  const user = await sql.begin(async (tx) => {
    const created = await createUser(tx, {
      email,
      passwordHash,
      name: name?.trim() || email.split('@')[0] || '',
    })

    if (invited?.invite) {
      await acceptInviteInto(tx, created, invited.invite.org, invited.invite.role)
      await markInviteAccepted(tx, invited.invite.id, created.id)
    }
    else {
      await createOrganizationFor(tx, created)
    }
    return created
  })

  await startSession(event, user.id)
  return { id: user.id, email: user.email }
})
