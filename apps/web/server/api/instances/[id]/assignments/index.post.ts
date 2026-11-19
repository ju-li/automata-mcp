import { z } from 'zod'

const body = z.union([
  z.object({ userId: z.string().min(1) }),
  z.object({ inviteId: z.string().min(1) }),
])

/**
 * Give a member the use of this connection: its dashboard, and connector tokens
 * on it. Never the right to change it — that stays with admins and the
 * connection's creator.
 *
 * `inviteId` instead of `userId` gives it to someone with a pending member
 * invitation, from the moment they accept.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  if ('inviteId' in parsed) {
    // Someone not yet in the organization: the assignment waits on the
    // invitation and lands when it is accepted. Admin-only, like the list of
    // invitations itself; 404 for anyone else, who cannot see that it exists.
    if (actor.role !== 'admin') throw createError({ statusCode: 404, statusMessage: 'Not found' })
    await assignInvite(actor.org.id, instance.id, parsed.inviteId)
    return { ok: true }
  }

  await assignInstance(actor.org.id, instance.id, parsed.userId)
  return { ok: true }
})
