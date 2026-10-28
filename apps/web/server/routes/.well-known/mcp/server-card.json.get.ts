import { z } from 'zod'
import { tools } from '#nuxt-mcp-toolkit/tools.mjs'
import { version } from '../../../../../../package.json'

/**
 * A static description of every tool this server can expose, for directories
 * (Smithery among them) that cannot complete a `tools/list` scan behind our
 * token.
 *
 * **Public on purpose, and safe to be.** It answers with the toolkit's own
 * registry — names, titles, descriptions, input schemas, annotations — which is
 * source code, the same for every deployment, and already in the public repo.
 * It reads no request, no session and no database, so nothing about any
 * connection or organization can appear here.
 *
 * **The card is the union across kinds; no token ever sees it whole.** A live
 * `tools/list` answers only the tools of the token's own connection kind (the
 * kind gate in `isToolAllowed`). That gate is untouched: this route lists
 * definitions, it does not register or run anything. Each tool carries the
 * kinds it serves under `_meta`, so a reader can tell the four sets apart.
 *
 * Read from the registry rather than a hand-kept list for the same reason as
 * `api/instances/[id]/mcp-tools.get.ts`: a separate list drifts the first time
 * someone adds a tool.
 */
export default defineEventHandler(() => ({
  serverInfo: { name: 'Automata', version },
  authentication: { required: true, schemes: ['bearer'] },
  tools: tools
    .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
    .map(tool => ({
      name: tool.name!,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description || '',
      inputSchema: z.toJSONSchema(z.object(tool.inputSchema ?? {}), {
        io: 'input',
        unrepresentable: 'any',
      }),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { kinds: kindsForTool(tool.name!) ?? [] },
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  resources: [],
  prompts: [],
}))
