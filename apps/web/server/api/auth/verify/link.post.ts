import { z } from 'zod'

const body = z.object({
  token: z.string().min(20).max(200),
})

/**
 * The token from the verification link. A POST from the page's Confirm button,
 * never a GET: mail scanners open links, and opening one must not spend it.
 */
export default defineEventHandler(async (event) => {
  const { token } = await parseBody(event, body)
  return await verifyByLink(event, token)
})
