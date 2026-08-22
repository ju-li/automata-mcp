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
      'This server exposes one user\'s WhatsApp account via the Evolution API.',
      'Call `list-instances` first to discover which instance names exist and which are connected;',
      'every other tool takes an `instance` name from that list.',
      'Only instances in the `open` state can send or receive messages.',
    ].join(' '),
    // Opt out of evlog wide-events on the MCP route. Request bodies and headers on
    // /mcp carry bearer tokens; see server/utils/redact.ts.
    logging: false,
  },

  runtimeConfig: {
    pocketbaseUrl: '',
    pocketbaseAdminEmail: '',
    pocketbaseAdminPassword: '',

    // Dev fallback only. Real credentials are per-user and live on the PocketBase
    // user record; these are used when a user has none set.
    evolutionUrl: '',
    evolutionApiKey: '',

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
