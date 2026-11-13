import { z } from 'zod'

const query = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
})

/**
 * One page of a token's recorded tool calls, newest first, with the reasons the
 * model gave. See server/utils/tool-calls.ts.
 *
 * Organization admins only. The reasons are model-written and can quote what a
 * colleague asked Claude about, so neither a member who created the connection
 * (who manages its tokens otherwise) nor the token's own holder reads them:
 * Telemetry is the organization's record, kept by its admins. A token the actor
 * cannot see at all is still 404 (`resolveTokenForActor`); one they can see is
 * 403.
 *
 * `toolCalls` says whether the organization records at all, so an empty list can
 * say "not recorded" rather than "never called".
 */
export default defineEventHandler(async (event) => {
  const { token, actor } = await resolveTokenForActor(event, getRouterParam(event, 'id'))
  if (actor.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Only an organization admin can see a token\'s tool calls.' })
  }
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
