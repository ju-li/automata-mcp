import { z } from 'zod'

const body = z.object({
  number: z.string().min(3).max(30),
})

/**
 * Turn a typed phone number into the JID scope will be matched against.
 *
 * Delegated to Evolution rather than normalised here: its rules are
 * country-specific (Brazil's ninth digit, Mexico and Argentina prefixes), and a
 * JID stored by our rules but matched by theirs is a scope that quietly does the
 * wrong thing.
 *
 * The lookup goes through Baileys, so it needs a connected account. Say that
 * plainly instead of returning a confusing failure.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  const { number } = await parseBody(event, body)

  let resolved: { jid: string, exists: boolean, name?: string }
  try {
    resolved = await resolveNumberToJid(instance, number)
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 422) throw error
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
})
