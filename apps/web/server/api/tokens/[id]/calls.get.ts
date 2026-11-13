import { z } from 'zod'

const query = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
})

/**
 * One page of a token's recorded tool calls, newest first, with the reasons the
 * model gave. See server/utils/tool-calls.ts.
 *
 * Visible exactly where the token is: whoever manages the connection (an admin,
 * or the member who created it), or the member it was issued to. A colleague's token is 404, as on every other
 * token route (`resolveTokenForActor`).
 *
 * `toolCalls` says whether the organization records at all, so an empty list can
 * say "not recorded" rather than "never called".
 */
export default defineEventHandler(async (event) => {
  const { token, actor } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  const { page: pageNumber } = await getValidatedQuery(event, q => query.parse(q))

  try {
    const [page, toolCalls] = await Promise.all([
      listToolCalls(token.id, pageNumber),
      loadToolCallSetting(actor.org.id),
    ])
    return { ...page, page: pageNumber, toolCalls }
  }
  catch (error) {
    // A handled 503 is invisible to Nitro; say why here. Token id only.
    console.error(`[tool-calls] could not read the calls of token ${token.id}:`, (error as Error)?.message ?? error)
    throw appDbUnavailable(error)
  }
})
