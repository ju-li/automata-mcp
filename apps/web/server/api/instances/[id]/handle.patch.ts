import { z } from 'zod'

const body = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,19}$/, 'Use 1–20 lowercase letters, digits or underscores, starting with a letter.'),
})

/**
 * Rename a connection's handle — the prefix of its tool names in every OAuth
 * sign-in. Admin-only, and on purpose rather than following the label: a
 * rename changes tool names in every client that has this connection, which
 * resets any per-tool permission the user set there.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const { handle } = await parseBody(event, body)
  if (handle === instance.handle) return { handle }
  try {
    await updateRow('instances', instance.id, { handle })
  }
  catch (error) {
    if (isUniqueViolation(error)) {
      throw createError({ statusCode: 409, statusMessage: `Another connection in your organization already uses “${handle}”.` })
    }
    throw error
  }
  return { handle }
})
