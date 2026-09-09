import { z } from 'zod'

/**
 * Create a connection.
 *
 * A discriminated union on `kind`, so each kind validates only its own fields
 * and an unknown kind is a 400 rather than a half-built row. `kind` defaults to
 * `whatsapp`: a client written before Postgres connections existed keeps
 * working unchanged.
 *
 * The WhatsApp `server` pair is all-or-nothing. Half of it is not a partial
 * override to be completed from configuration — see `evolutionAdminCredentials`
 * for why pairing our key with their URL, or theirs with ours, is the bug this
 * shape prevents.
 */
const body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('whatsapp').default('whatsapp'),
    label: z.string().max(100).optional(),
    server: z.object({
      baseUrl: z.string().url(),
      adminKey: z.string().min(1),
    }).optional(),
  }),
  z.object({
    kind: z.literal('postgres'),
    label: z.string().max(100).optional(),
    dsn: z.string().min(1).max(2000),
  }),
])

export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const parsed = await parseBody(event, body)

  const instance = parsed.kind === 'postgres'
    ? await provisionPostgresInstance(user, { label: parsed.label, dsn: parsed.dsn })
    : await provisionWhatsappInstance(user, { label: parsed.label, server: parsed.server })

  return { instance: toPublicInstance(instance) }
})
