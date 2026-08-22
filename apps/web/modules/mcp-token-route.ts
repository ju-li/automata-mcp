import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { addServerHandler, defineNuxtModule, resolvePath } from '@nuxt/kit'

/**
 * Registers `/mcp/:token` alongside the module's own `/mcp`.
 *
 * Claude and several other MCP clients cannot attach an `Authorization` header
 * to a custom connector, so the token has to be able to ride in the URL.
 *
 * Why a second route rather than rewriting the URL in middleware: h3 1.15.x
 * captures the request path once at app entry and re-assigns `event._path`
 * before every layer, so a `server/middleware/` rewrite is clobbered before the
 * router ever sees it.
 *
 * Why this is safe to claim: @nuxtjs/mcp-toolkit registers `/mcp/:handler` only
 * when *named* handlers exist (`server/mcp/handlers/<name>/`). We have none —
 * `server/mcp/index.ts` is the default-handler override and is explicitly
 * excluded from that count — so the path is free. Naming our param `token`
 * rather than `handler` means the toolkit's `getRouterParam(event, 'handler')`
 * misses and it falls through to our default handler: same tools, same auth
 * middleware, one code path, no internal re-dispatch.
 *
 * Static routes (`/mcp/deeplink`, `/mcp/badge.svg`) still win over the param
 * segment in the router.
 *
 * FRAGILE: this deep-resolves a path inside @nuxtjs/mcp-toolkit that is not in
 * its `exports` map. Pinned to 0.19.0. If a release moves the file, this throws
 * at build with the message below. Fallback would be a
 * `server/routes/mcp/[token].ts` that re-dispatches to `/mcp` via `$fetch.raw`
 * with the token promoted to an Authorization header.
 */
export default defineNuxtModule({
  meta: {
    name: 'mcp-token-route',
    configKey: 'mcpTokenRoute',
  },
  async setup() {
    // resolvePath honours the package's `exports` map (which exposes only an
    // `import` condition — createRequire cannot resolve it).
    const entry = await resolvePath('@nuxtjs/mcp-toolkit')
    const handler = resolve(dirname(entry), 'runtime/server/mcp/handler.js')

    if (!existsSync(handler)) {
      throw new Error(
        `[mcp-token-route] Could not find the MCP request handler at ${handler}. `
        + 'The @nuxtjs/mcp-toolkit internal layout changed. See the note in '
        + 'apps/web/modules/mcp-token-route.ts for the fallback.',
      )
    }

    addServerHandler({ route: '/mcp/:token', handler })
  },
})
