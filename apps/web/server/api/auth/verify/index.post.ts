import { z } from 'zod'

const body = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code from the email'),
})

/**
 * The code from the verification mail, typed into the browser that started it
 * (the `automata_verify` cookie names the row). A signup is created and signed
 * in; an address change takes effect.
 */
export default defineEventHandler(async (event) => {
  const { code } = await parseBody(event, body)
  return await verifyByCode(event, code)
})
