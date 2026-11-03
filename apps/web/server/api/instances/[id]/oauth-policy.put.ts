import { z } from 'zod'

const body = z.object({
  membersAllowed: z.boolean(),
}).and(scopeSchema).and(disclaimerSchema)

/**
 * Set the connection's sign-in ceiling. Admin-only (`requireManagedInstance`):
 * it decides what members may grant themselves, which is the same decision as
 * minting them a token.
 *
 * Takes effect on the next MCP request — every OAuth connection a member holds
 * is intersected with the current ceiling as it is resolved — so nothing is
 * rewritten here and narrowing it cannot leave a wider grant behind.
 */
export default defineEventHandler(async (event) => {
  const { instance, actor } = await requireManagedInstance(event, getRouterParam(event, 'id'))
  const parsed = await parseBody(event, body)
  const scope = scopeFromInput(parsed)

  const sql = await appDb()
  const values = {
    instance: instance.id,
    members_allowed: parsed.membersAllowed,
    all_chats: scope.allChats,
    chat_jids: scope.allChats ? [] : scope.chatJids,
    all_tables: scope.allTables,
    table_names: scope.allTables ? [] : scope.tableNames,
    all_tools: scope.allTools,
    tool_names: scope.allTools ? [] : scope.toolNames,
    send_disclaimer: parsed.send_disclaimer ?? null,
    updated_by: actor.user.id,
    updated: new Date(),
  }
  await sql`
    INSERT INTO app.connection_oauth_policy ${sql(values)}
    ON CONFLICT (instance) DO UPDATE SET ${sql(values, 'members_allowed', 'all_chats', 'chat_jids', 'all_tables', 'table_names', 'all_tools', 'tool_names', 'send_disclaimer', 'updated_by', 'updated')}
  `
  return { ok: true }
})
