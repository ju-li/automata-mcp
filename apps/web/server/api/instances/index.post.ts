import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
}).optional()

/** Provision a new Evolution instance for the signed-in user. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const parsed = await parseBody(event, body)

  const instance = await provisionInstance(user, parsed?.label)
  return { instance: toPublicInstance(instance) }
})
