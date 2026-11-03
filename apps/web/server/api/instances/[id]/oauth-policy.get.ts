/**
 * The connection's sign-in ceiling: whether members may connect it from an MCP
 * client by OAuth, and the most they may grant it. Readable by anyone who
 * reaches the connection — a member is shown what they could grant — while only
 * an admin may change it (`oauth-policy.put.ts`).
 *
 * No row reads as "members not allowed" with the kind's default scope as the
 * suggested ceiling, so the editor opens on something sensible.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  const sql = await appDb()
  const [row] = await sql`SELECT * FROM app.connection_oauth_policy WHERE instance = ${instance.id}`
  const scope = row ? scopeFromRecord(row) : defaultScopeFor(instanceKind(instance))
  return {
    oauthAvailable: Boolean(oauthSettings()),
    handle: instance.handle,
    membersAllowed: Boolean(row?.members_allowed),
    scope: scopeToInput(scope),
    send_disclaimer: (row?.send_disclaimer as string | undefined) || undefined,
  }
})
