import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
}).and(scopeSchema)

/**
 * Mint a connector token for this connection.
 *
 * Admin-only: what a token may reach is an organization decision, and a member
 * who could mint one could grant themselves any scope the connection has. A
 * member's recourse for a compromised token is to rotate its secret, which
 * changes nothing about what it reaches.
 *
 * The token is assigned to the acting admin. PR 3 adds an `assignedTo` so an
 * admin can issue one to a member, and with it the check that the target
 * actually reaches this connection — minting for someone with no assignment
 * would produce a token that is born dead and still reads "Active".
 *
 * The plaintext is in this response and nowhere else — only its SHA-256 hash is
 * stored. The UI must show it once and say so.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  const { token, record } = await createToken({
    instanceId: instance.id,
    assignedTo: actor.user.id,
    createdBy: actor.user.id,
    label: parsed.label ?? '',
    preset: parsed.expiry,
    scope: scopeFromInput(parsed),
  })

  return { token, record }
})
