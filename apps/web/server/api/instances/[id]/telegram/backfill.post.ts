import { z } from 'zod'

const body = z.object({
  // A marked chat id as a string: a JS number would round a 64-bit id into a different chat.
  chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id as a string of digits'),
})

/**
 * Load more of one chat's older history: up to another
 * `TELEGRAM_BACKFILL_MAX_PER_CHAT` messages, for a chat whose history stopped
 * at that count. The day limit stays — a chat that reaches it stops there.
 *
 * Managers only, like pairing: it spends requests on the linked account, and an
 * account that hammers history is how Telegram restricts one. Refused with 402
 * `plan_limit` where the plan syncs recent history only (`historyLimited`), so a
 * bring-your-own bridge and every self-hosted connection may always ask.
 *
 * Answers once the bridge has stored it; the messages arrive at backfill's own
 * pace, newest chat first among whatever else is still being fetched.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'telegram')
  const { chatId } = await parseBody(event, body)
  if (await historyLimited(instance)) throw moreHistoryLimitError()

  const bridge = telegramBridgeForInstance(instance)
  try {
    return await bridge.backfill(chatId)
  }
  catch (error) {
    // A bridge from before this route answers its generic 404 with no `code`,
    // which would otherwise pass through as "Not found." — read as the chat
    // missing. Every 404 this route really sends carries `chat_unknown`.
    if (httpStatusOf(error) === 404 && (error as { data?: { code?: unknown } }).data?.code === undefined) {
      console.error(`[telegram] could not load more history for connection ${instance.id}: the Telegram bridge is too old to extend a chat's history. Update the bridge to the same release as the app.`)
      throw createError({ statusCode: 503, statusMessage: 'Loading more history is not available yet on this deployment. Try again later.' })
    }
    relayBridgeError(error, 'load more history')
  }
})
