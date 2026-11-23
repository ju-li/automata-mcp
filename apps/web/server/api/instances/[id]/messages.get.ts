import { z } from 'zod'
import { assertNever } from '#shared/connection'

/**
 * Every message on a messaging connection, as one searchable, paged table — the
 * dashboard's Messages card.
 *
 * Search and paging are done in SQL over the whole account, never over rows a
 * client has fetched: a `Message` table runs to six figures, so a page has to be
 * a page of everything, and a search that only saw the current page would be a
 * search that quietly answers about the wrong set.
 *
 * Ordering is by time alone, and that is a limit rather than an omission —
 * `listAccountMessages` explains why a name column cannot be sorted here.
 *
 * **Totals are cheap, so not always exact.** The last page carries an exact
 * `total` for free. Before it, a page without a search has none — the dialog
 * shows the dashboard's cached message count, marked as approximate — and a
 * search's `total` is a capped count (`MATCH_COUNT_CAP`, short timeout): exact
 * below the cap, `totalAtLeast: true` at it, absent if it ran out of time. Exact counts across a multi-million-message
 * account read every row and ran past the statement timeout (see
 * `listAccountMessagesPage`, `listTelegramAccountMessages`).
 *
 * A connection with no database URL is refused by the same precedence rule the
 * MCP read path uses, and with the same two answers it gives: a 500 naming the
 * missing deployment-wide setting, or a 501 for a connection on a server of the
 * user's own that has no database URL of its own. Never an empty page — "I
 * cannot read this" and "there is nothing here" are different answers. The
 * dashboard does not normally reach either: `canReadMessages` is false in both
 * cases, and the card that opens this table is not clickable then.
 */
const MAX_LIMIT = 200

const query = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  page: z.coerce.number().int().min(1).default(1),
  q: z.string().optional(),
  order: z.enum(['newest', 'oldest']).default('newest'),
})

export default defineEventHandler(async (event) => {
  const { instance, kind } = await requireReadableInstanceOfKinds(event, getRouterParam(event, 'id'), ['whatsapp', 'telegram'])

  const params = await getValidatedQuery(event, q => query.parse(q))

  // Split the way the search tools split, so one box behaves the same wherever
  // it appears: every word has to be in the message, in any order.
  // Bounded the same way too: these terms run on the pool every account on our
  // own server shares (`search-terms.ts`).
  const terms = params.q === undefined ? undefined : splitSearchTerms(params.q.trim(), 'q')

  switch (kind) {
    case 'whatsapp':
      return await listAccountMessages(instance, {
        limit: params.limit,
        page: params.page,
        order: params.order,
        ...(terms?.length && { terms }),
      })
    case 'telegram': {
      const result = await listTelegramAccountMessages(instance, {
        limit: params.limit,
        page: params.page,
        order: params.order,
        ...(terms?.length && { terms }),
      })

      // Named rather than left to the reader: a table that silently drops a
      // class of row reads as a complete one. Named, not counted — counting
      // them reads every row of the session (`listTelegramAccountMessages`).
      return { ...result, excludes: ['deleted', 'service'] as const }
    }
    default:
      return assertNever(kind, 'connection kind')
  }
})
