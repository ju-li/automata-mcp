import { z } from 'zod'

/**
 * The account's contacts, as one searchable, paged table — the dashboard's
 * Contacts card.
 *
 * WhatsApp only, and 404 for anything else like every other kind-guarded route:
 * the route genuinely does not exist for a Postgres or a Telegram connection,
 * and a distinguishable error would turn it into a probe for which id is which
 * kind.
 *
 * Readable rather than managed: a member assigned to this connection already
 * reaches these names through `list-chats` and every message they read, so
 * refusing them here while serving them on the wire would be incoherent.
 */
const MAX_LIMIT = 500

const query = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  page: z.coerce.number().int().min(1).default(1),
  q: z.string().optional(),
  sort: z.enum(['name', 'number']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
})

export default defineEventHandler(async (event) => {
  const { instance } = await requireReadableInstanceOfKind(event, getRouterParam(event, 'id'), 'whatsapp')

  const params = await getValidatedQuery(event, q => query.parse(q))

  return await listContacts(instance, params)
})
