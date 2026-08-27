import tailwindcss from '@tailwindcss/vite'

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
    name: 'WhatsApp (Evolution API)',
    version: '0.1.0',
    route: '/mcp',
    instructions: [
      'This server is bound to exactly one WhatsApp account — the one the connector token was issued for.',
      'There is no account to choose and no tool takes an instance argument.',
      'Call `get-connection-status` to check that the account is connected (state `open`) before sending;',
      'in any other state, messages cannot be sent and the user needs to re-pair in the web app.',
      'Reading and searching only cover messages recorded since the account was connected;',
      'WhatsApp history from before pairing was never imported, so an empty result means',
      'nothing was recorded, not that the conversation did not happen.',
    ].join(' '),
    // Opt out of evlog wide-events on the MCP route. Request bodies and headers on
    // /mcp carry bearer tokens; see server/utils/redact.ts.
    logging: false,
  },

  runtimeConfig: {
    pocketbaseUrl: '',
    pocketbaseAdminEmail: '',
    pocketbaseAdminPassword: '',

    // Where every provisioned instance lives. Required.
    evolutionUrl: '',
    // Evolution's global key. Used ONLY to create and delete instances, by
    // server/utils/instances.ts. Never stored on a record and never used to
    // serve a request on behalf of a user — see server/utils/evolution.ts.
    evolutionAdminKey: '',
    // Read-only connection to Evolution's own Postgres, for message search only.
    // Optional: unset, the search tool is not registered. This reaches every
    // user's messages, so the role behind it must be SELECT-only — see
    // server/utils/evolution-db.ts and README "Message search".
    evolutionDatabaseUrl: '',

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
