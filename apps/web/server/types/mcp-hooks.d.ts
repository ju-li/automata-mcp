import type { H3Event } from 'h3'

/**
 * `mcp:config:resolved`, declared locally.
 *
 * @nuxtjs/mcp-toolkit ships this augmentation in
 * `dist/runtime/server/types/hooks.d.ts`, but that file is not reachable through
 * the package's `exports` map and is not pulled into our tsconfig, so the hook
 * name does not typecheck without this. Referencing it by path would hardcode a
 * pnpm content hash.
 *
 * Narrowed on purpose: `config` is typed with only the field
 * server/plugins/mcp-instructions.ts writes. A wider local copy of the toolkit's
 * `McpResolvedConfig` would be a second definition to keep in sync, and would
 * silently stop matching on a bump — which is exactly the failure this project
 * already guards against for the token route.
 */
declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'mcp:config:resolved': (ctx: {
      config: { instructions?: string }
      event: H3Event
    }) => void | Promise<void>
  }
}

export {}
