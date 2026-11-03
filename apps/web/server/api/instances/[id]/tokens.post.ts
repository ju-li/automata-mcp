import { z } from 'zod'

const body = z.object({
  label: z.string().max(100).optional(),
  expiry: z.enum(['30d', '90d', '1y', 'never']).default('90d'),
  /** The member to issue it to. Defaults to the acting admin. */
  assignedTo: z.string().min(1).optional(),
}).and(scopeSchema).and(disclaimerSchema)

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
 * stored. The UI must show it once and say so. (OAuth connections are not minted
 * here: they are created when a sign-in's code is exchanged — see oauth.ts.)
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)

  return await issueConnectorToken({
    actor,
    instance,
    assignedTo: parsed.assignedTo ?? actor.user.id,
    label: parsed.label ?? '',
    preset: parsed.expiry,
    scope: scopeFromInput(parsed),
    sendDisclaimer: parsed.send_disclaimer,
  })
})
