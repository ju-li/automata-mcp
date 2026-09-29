import { z } from 'zod'

const body = z.object({
  /**
   * Required here, where create leaves it optional.
   *
   * `provisionInstance` has a per-kind fallback to fall back to — "WhatsApp
   * account", the probed database name, "Telegram account". A rename has none,
   * and an empty label renders as a blank heading with no visible control left
   * to fix it.
   */
  label: z.string().trim().min(1, 'Give the connection a name').max(100),
})

/**
 * Rename a connection.
 *
 * This is `instances.label`, the nickname, and never `instances.name` — that one
 * is the Evolution instance name and the Telegram bridge session name, is in
 * every backend URL built for this row, and is uniquely indexed. Renaming it
 * would desync the backend from the record of it.
 *
 * Admin-only and kind-agnostic: the connection belongs to the organization, so
 * what it is called is management rather than use, and a label means the same
 * thing whatever is on the other end of it.
 *
 * No util in `instances.ts` behind it, unlike the three credential PATCHes
 * beside it: those carry side effects — a host guard, a live probe, a pool to
 * drop. A label has none, so the write is one column and stays here.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const { label } = await parseBody(event, body)

  const pb = await pocketbaseAdmin()
  const updated = await pb.collection('instances').update<AppInstance>(instance.id, { label })

  return { instance: toPublicInstance(updated) }
})
