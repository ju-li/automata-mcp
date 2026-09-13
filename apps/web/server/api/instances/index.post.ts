import { assertNever } from '#shared/connection'
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
 *
 * `dbUrl` sits inside `server` because it only means anything for a user's own
 * server, and is optional inside it because reading is the only thing it buys:
 * pairing, listing chats and sending all work without it.
 */
const body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('whatsapp').default('whatsapp'),
    label: z.string().max(100).optional(),
    server: z.object({
      baseUrl: z.string().url(),
      adminKey: z.string().min(1),
      dbUrl: z.string().min(1).max(2000).optional(),
    }).optional(),
  }),
  z.object({
    kind: z.literal('postgres'),
    label: z.string().max(100).optional(),
    dsn: z.string().min(1).max(2000),
  }),
])

export default defineEventHandler(async (event) => {
  // Admin-only: a connection costs money and, for WhatsApp, a real phone number.
  // The organization owns whatever is created here; the acting admin is recorded
  // as its creator and gains nothing extra by it.
  const actor = await requireOrgAdmin(event)
  const parsed = await parseBody(event, body)

  let instance
  switch (parsed.kind) {
    case 'postgres':
      instance = await provisionPostgresInstance(actor, { label: parsed.label, dsn: parsed.dsn })
      break
    case 'whatsapp':
      instance = await provisionWhatsappInstance(actor, { label: parsed.label, server: parsed.server })
      break
    default:
      return assertNever(parsed, 'connection kind')
  }

  return { instance: toPublicInstance(instance) }
})
