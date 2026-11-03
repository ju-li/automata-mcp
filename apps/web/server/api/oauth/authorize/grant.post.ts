import { z } from 'zod'

const body = z.object({
  connection: z.string().min(1),
  label: z.string().trim().max(100).optional(),
})

/**
 * The consent page's shortcut for an admin with nothing to approve: create an
 * OAuth grant for themselves on one of their connections, with the default
 * scope a new token gets from the dialog (`defaultScopeFor`). Exactly the mint
 * path the dashboard uses — `requireManagedInstance`, then
 * `issueConnectorToken` with its limit check and hosted event — so there is no
 * second way to make a token.
 *
 * Admin-only by construction: `requireManagedInstance` refuses a member, who
 * could otherwise mint themselves a grant from here.
 */
export default defineEventHandler(async (event) => {
  const settings = requireOAuth()
  assertSameOrigin(event, settings)
  const parsed = await parseBody(event, body)
  const { instance, actor } = await requireManagedInstance(event, parsed.connection)

  const { record } = await issueConnectorToken({
    actor,
    instance,
    assignedTo: actor.user.id,
    label: parsed.label || 'Claude',
    preset: '90d',
    scope: defaultScopeFor(instanceKind(instance)),
    oauth: true,
  })
  return { id: record.id }
})
