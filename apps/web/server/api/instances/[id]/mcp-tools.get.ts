import { tools } from '#nuxt-mcp-toolkit/tools.mjs'

/**
 * The tool catalogue the scope editor renders checkboxes from, for one
 * connection.
 *
 * Read from the toolkit's own registry rather than a hand-kept list, so the
 * options a user sees are exactly the tools that exist. A separate registry
 * would drift the first time someone adds a tool and forgets it.
 *
 * Instance-scoped rather than global, for two reasons. A connection only ever
 * sees the tools of its own kind — granting a Postgres token `send-text-message`
 * grants nothing, because the kind gate in `isToolAllowed` refuses it — so
 * offering the checkbox is an invitation to a misunderstanding. And a tool with
 * an unmet prerequisite is filtered out here too: `search-messages` is not
 * registered at all when `NUXT_EVOLUTION_DATABASE_URL` is unset, and used to be
 * offered anyway.
 *
 * `readOnly` drives the default selection for a new Postgres token, so it has to
 * be right — it comes from the tool's own `readOnlyHint`.
 */
export default defineEventHandler(async (event) => {
  const instance = await requireOwnedInstance(event, getRouterParam(event, 'id'))
  const kind = instanceKind(instance)

  const available = tools
    .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
    .filter(tool => (tool.group ?? (tool._meta as { group?: string } | undefined)?.group) === kind)
    .filter(tool => tool.name !== 'search-messages' || messageSearchConfigured())

  return {
    tools: available
      .map(tool => ({
        name: tool.name!,
        title: tool.title || tool.name!,
        description: tool.description || '',
        readOnly: tool.annotations?.readOnlyHint === true,
      }))
      .sort((a, b) => Number(b.readOnly) - Number(a.readOnly) || a.title.localeCompare(b.title)),
  }
})
