import { z } from 'zod'
import { assertNever } from '#shared/connection'

const whatsappBody = z.object({
  number: z.string().min(3).max(30),
})

const telegramBody = z.object({
  query: z.string().trim().min(2).max(256),
})

/**
 * Turn what someone typed into the chat id scope will be matched against.
 *
 * WhatsApp: a phone number, delegated to Evolution rather than normalised here —
 * its rules are country-specific (Brazil's ninth digit, Mexico and Argentina
 * prefixes), and a JID stored by our rules but matched by theirs is a scope that
 * quietly does the wrong thing.
 *
 * Telegram: an @username, a t.me link or a phone number, resolved by the bridge
 * to the marked chat id. Answered as `jid` so the picker handles both kinds alike.
 *
 * Both lookups need a connected account. Say that plainly instead of returning a
 * confusing failure.
 */
export default defineEventHandler(async (event) => {
  const { instance, kind } = await requireReadableInstanceOfKinds(event, getRouterParam(event, 'id'), ['whatsapp', 'telegram'])

  switch (kind) {
    case 'telegram': {
      const { query } = await parseBody(event, telegramBody)
      let resolved: BridgeResolved
      try {
        resolved = await telegramBridgeForInstance(instance).resolve(query)
      }
      catch (error) {
        relayBridgeError(error, 'look that up')
      }
      return {
        jid: resolved.chatId,
        name: resolved.title || (resolved.username ? `@${resolved.username}` : resolved.chatId),
        ...(resolved.username && { username: resolved.username }),
      }
    }

    case 'whatsapp': {
      const { number } = await parseBody(event, whatsappBody)

      let resolved: { jid: string, exists: boolean, name?: string }
      try {
        resolved = await resolveNumberToJid(instance, number)
      } catch (error) {
        if (httpStatusOf(error) === 422) throw error
        throw createError({
          statusCode: 409,
          statusMessage: 'Connect this WhatsApp account before adding numbers by hand',
          cause: error,
        })
      }

      if (!resolved.exists) {
        throw createError({
          statusCode: 422,
          statusMessage: 'That number is not on WhatsApp',
        })
      }

      return { jid: resolved.jid, name: resolved.name, number }
    }

    default:
      return assertNever(kind, 'connection kind')
  }
})
