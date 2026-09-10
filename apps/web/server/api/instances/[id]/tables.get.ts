import { z } from 'zod'

const query = z.object({
  search: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TABLE_PAGE).default(500),
  page: z.coerce.number().int().min(1).default(1),
})

/**
 * Tables this connection can reach, for the token scope picker.
 *
 * Deliberately the same `listPgTables` the MCP tool uses, so what an owner can
 * grant and what a model can see are computed once. Two queries that could
 * disagree about which tables exist would be a support problem the first time
 * they did.
 *
 * `OPEN_SCOPE` because this is the *owner* choosing what to grant: the picker
 * must show every table the connection reaches, not the subset some existing
 * token was given. Ownership is what authorises it, and `requireOwnedInstance`
 * has already established that.
 */
export default defineEventHandler(async (event) => {
  // 404 for the wrong kind, like every other kind-guarded route: this route
  // genuinely does not exist for a WhatsApp connection, and a distinguishable
  // error would turn it into a probe for which id is which kind.
  const instance = await requireOwnedInstanceOfKind(event, getRouterParam(event, 'id'), 'postgres')

  const params = await getValidatedQuery(event, q => query.parse(q))

  const { tables, hasMore } = await listPgTables(instance, OPEN_SCOPE, params)
  return { tables, hasMore }
})
