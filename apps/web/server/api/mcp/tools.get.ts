import { tools } from '#nuxt-mcp-toolkit/tools.mjs'

/**
 * The tool catalogue the scope editor renders checkboxes from.
 *
 * Read from the toolkit's own registry rather than a hand-kept list, so the
 * options a user sees are exactly the tools that exist. A separate registry
 * would drift the first time someone adds a tool and forgets it.
 */
export default defineEventHandler(async (event) => {
  await requireSessionUser(event)

  return {
    tools: tools
      .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
      .map(tool => ({
        name: tool.name!,
        title: tool.title || tool.name!,
        description: tool.description || '',
        readOnly: tool.annotations?.readOnlyHint === true,
      }))
      .sort((a, b) => Number(b.readOnly) - Number(a.readOnly) || a.title.localeCompare(b.title)),
  }
})
