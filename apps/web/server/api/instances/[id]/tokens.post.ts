import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
}).and(scopeSchema)

/**
 * Mint a connector token for this account.
 *
 * The plaintext is in this response and nowhere else — only its SHA-256 hash is
 * stored. The UI must show it once and say so.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  const { token, record } = await createToken(
    user.id,
    instance.id,
    parsed.label ?? '',
    parsed.expiry,
    scopeFromInput(parsed),
  )

  return { token, record }
})
