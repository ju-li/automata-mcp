import { z } from 'zod'
import type { AppUser } from '~~/server/utils/app-db'

const body = z.object({
  name: z.string().trim().min(1, 'Give yourself a display name').max(100),
})

/**
 * Change your own display name.
 *
 * No password proof, unlike the email and password routes next to it: a display
 * name is not a credential, and nothing in the app authorizes off it.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { name } = await parseBody(event, body)

  const updated = await updateRow<AppUser>('users', user.id, { name })
  return { name: updated.name }
})
