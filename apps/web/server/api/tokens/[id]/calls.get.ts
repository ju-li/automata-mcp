import { z } from 'zod'

const query = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
})

/**
 * One page of a token's recorded tool calls, newest first, with the reasons the
 * model gave. See server/utils/tool-calls.ts.
 *
 * Visible exactly where the token is: an admin of the connection's organization,
 * or the member it was issued to. A colleague's token is 404, as on every other
 * token route (`resolveTokenForActor`).
 *
 * `toolCalls` says whether the organization records at all, so an empty list can
 * say "not recorded" rather than "never called".
 */
export default defineEventHandler(async (event) => {
  const { token, actor } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  const parsed = query.safeParse(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid page' })

  try {
    const [page, toolCalls] = await Promise.all([
      listToolCalls(token.id, parsed.data.page),
      loadToolCallSetting(actor.org.id),
    ])
    return { ...page, page: parsed.data.page, toolCalls }
  }
  catch (error) {
    // A handled 503 is invisible to Nitro; say why here. Token id only.
    console.error(`[tool-calls] could not read the calls of token ${token.id}:`, (error as Error)?.message ?? error)
    throw appDbUnavailable(error)
  }
})
