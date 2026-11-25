// Tool modules register their kinds and costs as they load (`defineKindTool`);
// `isToolAllowed` and `costlyChargeFor` read those. This route is not `/mcp`, so on a
// fresh process the first followed link could arrive before anything loaded
// them: load them here too, as `mcp-tools.get.ts` does.
import '#nuxt-mcp-toolkit/tools.mjs'

/**
 * Follow a signed media URL minted by `download-whatsapp-media` / `download-telegram-media`.
 *
 * MCP side of the auth split: the bearer token is required here exactly as on
 * `/mcp` (never a cookie — `isMcpPath` covers this prefix, so the session
 * middleware skips it and the path is redacted from logs), and it must be the
 * token the URL was minted for. Then every check the tool ran is run again —
 * the token may have been narrowed or revoked since: the opt-in tool still
 * granted, the costly-tools budget, the chat in scope, the message in that chat.
 * Only then is the file fetched, fresh; nothing was stored when the URL was made.
 *
 * No usable token = 401, before the link is opened. Anything that does not
 * match answers 404, saying no more about a URL than that it leads nowhere —
 * except an expired one followed with its own token, which says so (410), since
 * "call the tool again" is the useful answer then.
 */
export default defineEventHandler(async (event) => {
  // The token first, before the link is even opened: a request without a usable
  // token gets 401 whatever the link is — genuine, expired or made up — so a
  // sealed URL held without its token cannot tell which. A valid token of
  // anyone else gets 404 for every link; only the link's own token learns that
  // it expired (410).
  const auth = await resolveMcpAuth(event)
  if (!auth) return mcpUnauthorized()

  const check = verifyMediaRef(getRouterParam(event, 'blob'))
  if (!check.ok && check.reason === 'invalid') throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const { ref } = check
  if (auth.tokenId !== ref.t || auth.instance.id !== ref.i || auth.kind !== ref.k) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  if (!check.ok) {
    throw createError({ statusCode: 410, statusMessage: 'This download link has expired. Call the download tool again for a new one.' })
  }

  const refusal = await mcpLimitRefusal(auth.instance.org, auth.tokenId, auth.limits)
  if (refusal) return refusal

  event.context.mcpAuth = auth

  const tool = mediaToolFor(ref.k)
  if (!isToolAllowed(event, tool, ref.k, { optIn: true })) {
    throw createError({ statusCode: 403, statusMessage: 'This connector token may no longer download media.' })
  }

  // The tool call that minted this link was charged on /mcp, against the
  // token's and organization's budgets and the costly-tools one. Following it is
  // when the backend actually fetches the file, so only the per-connection
  // costly-tools budget is charged again: it protects that connection's
  // Evolution or bridge, whoever follows.
  const throttled = await takeMcpBudget(costlyChargeFor(auth, [{ name: tool, args: {} }]))
  if (throttled) return mcpRateLimited(throttled)

  // Counted and recorded like a call of the tool (name and outcome only), so a
  // followed link shows in usage and tool-call history too.
  const record = (ok: boolean) => {
    countToolCall(auth.instance.org, auth.tokenId, tool, ok)
    recordToolCall(auth, { tool, ok, reason: undefined, userAgent: getRequestHeader(event, 'user-agent') })
  }
  const headers = (mimeType: string, fileName: string | undefined, length?: number) => setResponseHeaders(event, {
    'content-type': mimeType,
    ...(length !== undefined && { 'content-length': length }),
    'content-disposition': attachmentDisposition(fileName),
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'default-src \'none\'; sandbox',
    'referrer-policy': 'no-referrer',
  })
  const maxBytes = mediaMaxBytes()

  switch (auth.kind) {
    // One bounded buffer: Evolution's only media route answers with the whole
    // file as base64 in a JSON body, so there is no stream to pass on. The slot
    // is held until that buffer has been delivered (or the delivery deadline
    // cut it off), so the slots bound the files held, not just the downloads.
    case 'whatsapp': {
      let release: (() => void) | undefined
      let file: MediaFile
      try {
        const target = await findWhatsappMedia(auth, ref.c, ref.m)
        if (target.meta.size !== undefined && target.meta.size > maxBytes) {
          throw createError({ statusCode: 413, statusMessage: 'File larger than this connector fetches.' })
        }
        release = acquireMediaSlot(auth.instance.id)
        file = await fetchWhatsappMedia(auth, target, maxBytes)
      }
      catch (error) {
        release?.()
        record(false)
        throw error
      }
      try {
        headers(file.mimeType, file.fileName, file.data.length)
        record(await pipeMediaToResponse(event, file.data, maxBytes, file.data.length))
      }
      finally {
        release()
      }
      return
    }

    // Streamed straight through from the bridge: one media slot held until the
    // pipe ends, however it ends (finished, cut off, or the client gone — which
    // also aborts the bridge request through `requestAbortSignal`).
    case 'telegram': {
      const messageId = Number(ref.m)
      let release: (() => void) | undefined
      let opened: Awaited<ReturnType<typeof openTelegramMedia>>
      try {
        await findTelegramMedia(auth, ref.c, messageId)
        release = acquireMediaSlot(auth.instance.id)
        opened = await openTelegramMedia(auth, ref.c, messageId, maxBytes, requestAbortSignal())
      }
      catch (error) {
        release?.()
        record(false)
        throw error
      }
      try {
        // A reported size over the cap is refused before anything is sent; the
        // pipe holds the stream to the cap either way.
        if (opened.meta.size !== undefined && opened.meta.size > opened.cap) {
          await opened.body.cancel().catch(() => {})
          record(false)
          throw createError({ statusCode: 413, statusMessage: 'File larger than this connector fetches.' })
        }
        // The bridge reports a size only when it is exact (a document's, or the
        // photo size it downloads) and fails a stream that ends short of it.
        headers(opened.meta.mimeType, opened.meta.fileName, opened.meta.size)
        record(await pipeMediaToResponse(event, opened.body, opened.cap, opened.meta.size))
      }
      finally {
        release()
      }
      return
    }

    default:
      record(false)
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
})
