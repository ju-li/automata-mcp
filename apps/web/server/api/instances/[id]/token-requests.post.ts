import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
}).and(scopeSchema).and(disclaimerSchema)

/**
 * Ask whoever manages this connection for a connector token.
 *
 * For a member who reaches the connection but does not manage it — a manager
 * mints directly, and is told so. The scope in the body is a proposal: the
 * approver may change any of it. Nothing about the request authenticates
 * until it is approved, and approval does not reveal a secret to anyone; the
 * member collects one afterwards from the token's row ("Get token").
 *
 * The approvers (the creator while they manage it, otherwise every admin) are
 * mailed when SMTP is configured. The request is stored first, so a mail that
 * fails costs nothing but the mail: it still shows on the token list.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  if (managesInstance({ role: actor.role, userId: actor.user.id }, instance, true)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'You manage this connection, so you can create a token yourself.',
    })
  }

  const record = await createTokenRequest(actor, instance, {
    label: parsed.label ?? '',
    preset: parsed.expiry,
    scope: scopeFromInput(parsed),
    sendDisclaimer: parsed.send_disclaimer,
  })

  const notified = await notifyTokenRequest(actor, instance, record.label)
  return { record, notified }
})
