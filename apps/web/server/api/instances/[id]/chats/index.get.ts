import { z } from 'zod'
import { assertNever } from '#shared/connection'

/**
 * Conversations for the scope picker and the dashboard's chat table, for a
 * WhatsApp or a Telegram connection. Telegram's rows come back in the same shape
 * — `jid` carries its chat id — so the picker and the dialog need no second copy.
 *
 * Two callers, two paging idioms, one listing behind both:
 *
 * - `?take=`/`?skip=` is the scope picker's: one large page in Evolution's own
 *   order, because it means to show everything and adding a number by hand is
 *   what covers a freshly paired account that lists nothing.
 * - `?page=`/`?limit=`, with `?q=`, `?sort=` and `?dir=`, is the dashboard
 *   table's. Searching and sorting happen over the **whole** account, not over
 *   the rows a client happened to fetch, which is why they are parameters here
 *   rather than work done in the browser.
 *
 * The reply is a page, and `hasMore` is the only completeness signal a client
 * should read. It is emphatically not the dashboard chat count: that counts a
 * different table (see `ChatPage` in `chats.ts`) and is routinely larger than
 * anything this can return.
 */
const MAX_TAKE = 2000
const MAX_LIMIT = 500

const query = z.object({
  take: z.coerce.number().int().min(1).max(MAX_TAKE).optional(),
  skip: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  page: z.coerce.number().int().min(1).optional(),
  q: z.string().optional(),
  sort: z.enum(['name', 'number', 'type', 'last']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
})

export default defineEventHandler(async (event) => {
  const { instance, kind } = await requireReadableInstanceOfKinds(event, getRouterParam(event, 'id'), ['whatsapp', 'telegram'])

  const params = await getValidatedQuery(event, q => query.parse(q))

  // The picker's idiom, kept whole: no search, no sort, Evolution's own order.
  // Decided on the table's own parameters, so a caller that sends none of them
  // still gets exactly what it used to get.
  const table = params.page !== undefined || params.limit !== undefined
    || params.q !== undefined || params.sort !== undefined
  const limit = params.limit ?? 100
  const page = params.page ?? 1

  switch (kind) {
    case 'whatsapp':
      return table
        ? await listChatsPage(instance, { ...params, limit, page })
        : await listChats(instance, { take: params.take, skip: params.skip })
    case 'telegram':
      // A database read, so it works while the account is disconnected.
      return await listTelegramChatsForPicker(instance, table
        ? { take: limit, skip: (page - 1) * limit, q: params.q, sort: params.sort, dir: params.dir }
        : { take: params.take ?? 500, skip: params.skip ?? 0 })
    default:
      return assertNever(kind, 'connection kind')
  }
})
