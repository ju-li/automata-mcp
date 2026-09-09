import tailwindcss from '@tailwindcss/vite'
import { WHATSAPP_INSTRUCTIONS } from './server/utils/mcp-instructions'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/tailwind.css'],

  vite: {
    plugins: [
      tailwindcss(),
    ],
  },

  modules: ['shadcn-nuxt', '@nuxtjs/mcp-toolkit'],

  nitro: {
    experimental: {
      // Required. MCP tool handlers are invoked by the MCP SDK and receive its
      // `RequestHandlerExtra` — not an H3 event. `useEvent()` is the only way to
      // reach per-request credentials from inside a tool, and it needs this flag.
      asyncContext: true,
    },
  },

  mcp: {
    // Static: the toolkit reads it before auth has run, so it cannot vary by
    // connection. Per-kind `instructions` can, and do.
    name: 'MCP Controller',
    version: '0.1.0',
    route: '/mcp',
    // The fallback, used for an unauthenticated request and if the hook in
    // server/plugins/mcp-instructions.ts ever stops firing. WhatsApp rather than
    // something neutral, so a degradation lands on today's behaviour.
    instructions: WHATSAPP_INSTRUCTIONS,
    // Opt out of evlog wide-events on the MCP route. Request bodies and headers on
    // /mcp carry bearer tokens; see server/utils/redact.ts.
    logging: false,
  },

  runtimeConfig: {
    pocketbaseUrl: '',
    pocketbaseAdminEmail: '',
    pocketbaseAdminPassword: '',

    // The *default* Evolution server, used by any WhatsApp connection that did
    // not bring its own. Optional: with these unset the app still runs, and the
    // WhatsApp create flow requires the user to supply a server.
    evolutionUrl: '',
    // That server's global key. Used ONLY to create and delete instances on it,
    // by server/utils/instances.ts. Never stored on a record and never used to
    // serve a request on behalf of a user — see server/utils/evolution.ts. A
    // user-supplied server carries its own key on the instance row instead; the
    // two are never cross-paired.
    evolutionAdminKey: '',
    // Read-only connection to Evolution's own Postgres, for message search only.
    // Optional: unset, the search tool is not registered. This reaches every
    // user's messages, so the role behind it must be SELECT-only — see
    // server/utils/evolution-db.ts and README "Message search".
    evolutionDatabaseUrl: '',

    // Let a user-supplied Postgres DSN or Evolution URL point at a private or
    // loopback address. Correct for a single-tenant, self-hosted deployment;
    // wrong for anything shared, where it lets one user's connection reach this
    // deployment's own backends. See server/utils/net-guard.ts.
    allowPrivateTargets: false,

    webhookUrl: '',
    webhookSecret: '',

    public: {
      appUrl: '',
    },
  },

  shadcn: {
    /**
     * Prefix for all the imported component.
     * @default "Ui"
     */
    prefix: '',
    /**
     * Directory that the component lives in.
     * Will respect the Nuxt aliases.
     * @link https://nuxt.com/docs/api/nuxt-config#alias
     * @default "@/components/ui"
     */
    componentDir: '@/components/ui',
  },
})
