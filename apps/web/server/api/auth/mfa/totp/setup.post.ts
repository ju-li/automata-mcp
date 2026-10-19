import { z } from 'zod'
import QRCode from 'qrcode'

const body = z.object({ currentPassword: z.string().min(1) })

/**
 * Start adding an authenticator app: a fresh secret, not yet a factor. It
 * becomes one at `totp/confirm`, once a code from the app proves it was saved —
 * a secret nobody stored would otherwise lock its owner out at the next sign-in.
 * Starting again replaces an unconfirmed secret; a confirmed one must be
 * removed first.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const { currentPassword } = await parseBody(event, body)
  await requireCurrentPassword(user, currentPassword)

  const sql = await appDb()
  const secret = generateTotpSecret()
  const [row] = await sql`
    INSERT INTO app.totp_credentials (user_id, secret)
    VALUES (${user.id}, ${secret})
    ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, last_step = 0, created = now()
      WHERE app.totp_credentials.confirmed_at IS NULL
    RETURNING user_id
  `
  if (!row) {
    throw createError({ statusCode: 409, statusMessage: 'An authenticator app is already set up. Remove it first.' })
  }

  const uri = totpUri(secret, user.email, 'Automata')
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1 })
  return {
    secret,
    uri,
    qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  }
})
