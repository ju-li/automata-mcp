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
      'Reading and searching cover the history imported when the account was paired as well as',
      'everything since, so older conversations are reachable. An account paired before history',
      'import was added has only what arrived since.',
      '`read-messages` answers with one page, newest first, and says so: when its `hasMore` is true',
      'there are older messages you have not seen, including inside a `since`/`until` range you asked',
      'for. Page with `nextPage` until `hasMore` is false before summarising or reporting on a range,',
      'and treat `covered` — not the range you requested — as what you have actually read.',
      'Reactions are stored as ordinary messages, one record per emoji, and are left out of both',
      'reads and searches unless you pass `includeReactions: true` — a response that omitted them',
      'says so with `reactionsExcluded`. Ask for them when who reacted is the question, not to',
      'reconstruct what was said.',
      'WhatsApp delivers an edit as a separate record and never rewrites the original, so an edited',
      'message appears twice: once as it was first sent, and once with the new text and `editOf`',
      'naming the record it replaces. Read that pair as one message that changed. Some edits arrive',
      'encrypted for the chat\'s participants only — those come back with no text and',
      '`unreadable: \'encrypted-edit\'`, which means the current wording of that message is unknown to',
      'this connector and is not searchable; say so plainly rather than presenting the earlier version',
      'as final or calling it a missing message. WhatsApp\'s own control records — deletions,',
      'disappearing-message timer changes, key exchanges — carry nothing readable and are left out of',
      'reads; when any were, `protocolMessagesExcluded` says how many, and `totalMatching` still',
      'counts them.',
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
