import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
})

/**
 * Mint a connector token for this account.
 *
 * The plaintext is in this response and nowhere else — only its SHA-256 hash is
 * stored. The UI must show it once and say so.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  const { label, expiry } = body.parse(await readBody(event).catch(() => ({})))

  const { token, record } = await createToken(user.id, instance.id, label ?? '', expiry)

  return { token, record }
})
