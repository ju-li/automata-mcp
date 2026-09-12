import { z } from 'zod'
import type { AppUser } from '~~/server/utils/pocketbase'

const body = z.object({
  name: z.string().trim().min(1, 'Give yourself a display name').max(100),
})

/**
 * Change your own display name.
 *
 * No password proof, unlike the email and password routes next to it: a display
 * name is not a credential, and nothing in the app authorizes off it.
 *
 * Written through the caller's **own** client rather than `pocketbaseAdmin()`.
 * `users.updateRule` is `id = @request.auth.id`, so the caller is already
 * entitled to this write and the superuser client would be extra privilege for
 * nothing. The email route cannot do the same — see the comment there.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { name } = await parseBody(event, body)

  const pb = pocketbaseForRequest()
  // The middleware has already validated this cookie against PocketBase, so
  // loading it here is a parse, not a round-trip.
  pb.authStore.loadFromCookie(getRequestHeader(event, 'cookie') ?? '', PB_COOKIE)

  const updated = await pb.collection('users').update<AppUser>(user.id, { name })

  return { name: updated.name }
})
