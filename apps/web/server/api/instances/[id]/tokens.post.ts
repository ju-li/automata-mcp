import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
  /** The member to issue it to. Defaults to the acting admin. */
  assignedTo: z.string().min(1).optional(),
}).and(scopeSchema)

/**
 * Mint a connector token for this connection.
 *
 * Admin-only: what a token may reach is an organization decision, and a member
 * who could mint one could grant themselves any scope the connection has. A
 * member's recourse for a compromised token is to rotate its secret, which
 * changes nothing about what it reaches.
 *
 * An admin may issue a token **to** a member, and that member must already reach
 * this connection — be an admin, or hold an assignment on it. A token minted for
 * someone who does not is born dead: it would render as "Active" and answer 401
 * on every call, with nothing in the Nitro log. Refusing with a 422 that says to
 * assign the connection first is the difference between a clear error and an
 * afternoon of debugging.
 *
 * The assignment is deliberately **not** created as a side effect of minting.
 * That would quietly make "give them a token" mean "give them the dashboard".
 *
 * The plaintext is in this response and nowhere else — only its SHA-256 hash is
 * stored. The UI must show it once and say so.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  const assignedTo = parsed.assignedTo ?? actor.user.id

  if (assignedTo !== actor.user.id) {
    const member = await requireOrgMember(actor.org.id, assignedTo)
    const reaches = member.role === 'admin'
      || (await listInstanceAssignees(instance.id)).includes(assignedTo)

    if (!reaches) {
      throw createError({
        statusCode: 422,
        statusMessage: `${member.email} cannot reach this connection, so a token issued to them `
          + 'would not work. Assign the connection to them first.',
      })
    }
  }

  const { token, record } = await createToken({
    instanceId: instance.id,
    assignedTo,
    createdBy: actor.user.id,
    label: parsed.label ?? '',
    preset: parsed.expiry,
    scope: scopeFromInput(parsed),
  })

  return { token, record }
})
