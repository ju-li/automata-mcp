import { tools } from '#nuxt-mcp-toolkit/tools.mjs'

/**
 * The tool catalogue the scope editor renders checkboxes from, for one
 * connection.
 *
 * Read from the toolkit's own registry rather than a hand-kept list, so the
 * options a user sees are exactly the tools that exist. A separate registry
 * would drift the first time someone adds a tool and forgets it.
 *
 * Instance-scoped rather than global: a connection only ever sees the tools of
 * its own kind, because the kind gate in `isToolAllowed` refuses the rest — so
 * offering a Postgres token a `send-text-message` checkbox would grant nothing
 * and invite a misunderstanding.
 *
 * It deliberately does NOT filter on a tool's runtime prerequisites. Both
 * WhatsApp read tools need `NUXT_EVOLUTION_DATABASE_URL`, and they stay
 * registered and fail loudly when it is missing rather than disappearing — see
 * plugins/evolution-db-check.ts. Hiding one of the two here would be the worst
 * of both: a scope editor that disagrees with the tool list a client sees.
 *
 * `readOnly` drives the default selection for a new Postgres token, so it has to
 * be right — it comes from the tool's own `readOnlyHint`.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  const kind = instanceKind(instance)

  const available = tools
    .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
    .filter(tool => (tool.group ?? (tool._meta as { group?: string } | undefined)?.group) === kind)

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
