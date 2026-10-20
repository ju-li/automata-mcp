import { z } from 'zod'

const body = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']),
  user: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
})

/**
 * Replace a mailbox's credentials — a rotated app password, or a move to
 * another server.
 *
 * Proved by logging in before anything is stored, like creating one. Every
 * token on the connection keeps working: tokens name the connection, not the
 * password. When the new login is a different mailbox, the headers synced from
 * the old one are deleted first (`updateImapCredentials`).
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'imap')
  const input = await parseBody(event, body)

  const updated = await updateImapCredentials(instance, input)

  return { instance: toPublicInstance(updated) }
})
