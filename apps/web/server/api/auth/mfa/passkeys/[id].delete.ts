import { z } from 'zod'

const body = z.object({ currentPassword: z.string().min(1) })

/** Remove one of your passkeys. Someone else's id answers 404, like a missing one. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const id = getRouterParam(event, 'id')
  const { currentPassword } = await parseBody(event, body)
  await requireCurrentPassword(user, currentPassword)

  const sql = await appDb()
  const removed = await sql.begin(async (tx) => {
    await lockUserFactors(tx, user.id)
    const [row] = await tx`
      DELETE FROM app.webauthn_credentials WHERE id = ${id ?? ''} AND user_id = ${user.id} RETURNING id
    `
    if (row) await afterFactorRemoved(tx, user.id)
    return Boolean(row)
  })
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ok: true }
})
