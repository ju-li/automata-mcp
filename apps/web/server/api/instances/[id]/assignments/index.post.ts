import { z } from 'zod'

const body = z.object({
  userId: z.string().min(1),
})

/**
 * Give a member the use of this connection: its dashboard, and connector tokens
 * on it. Never the right to change it — that stays with admins and the
 * connection's creator.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const { userId } = await parseBody(event, body)

  await assignInstance(actor.org.id, instance.id, userId)
  return { ok: true }
})
