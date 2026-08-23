/**
 * `#nuxt-mcp-toolkit/tools.mjs` is a virtual module the toolkit generates at
 * build time (`addServerTemplate` in its loader). Nitro resolves it fine, but
 * the toolkit's ambient declaration lives inside its own package types and is
 * not visible to this project's generated tsconfigs.
 *
 * Declared here so `server/api/mcp/tools.get.ts` can read the real registry
 * instead of a hand-kept copy that would drift the first time a tool is added.
 * Only the fields that route actually reads are typed.
 */
declare module '#nuxt-mcp-toolkit/tools.mjs' {
  export const tools: Array<{
    name?: string
    title?: string
    description?: string
    annotations?: {
      readOnlyHint?: boolean
      destructiveHint?: boolean
      idempotentHint?: boolean
      openWorldHint?: boolean
    }
  }>
}
