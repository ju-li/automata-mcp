import { z } from 'zod'

const body = z.object({
  email: z.string().trim().email('Enter a valid email address').max(320),
})

/**
 * Self-hosted only: put an address on our update list (breaking changes,
 * security advisories). An admin's choice, made on the last setup step;
 * 404 on the hosted offering or where the operator turned it off. See
 * server/utils/onboarding.ts.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  if (!selfHostUpdatesUrl()) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  const { email } = await parseBody(event, body)
  const { confirm } = await subscribeToUpdates(actor, email)
  return { ok: true, confirm }
})
