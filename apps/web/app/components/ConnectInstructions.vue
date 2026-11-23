<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { assertNever } from '#shared/connection'

const props = defineProps<{
  kind: InstanceKind
  /**
   * The plaintext token, known only in the moment it is minted. Everywhere else
   * it is null and every value carrying it is masked and not copyable.
   */
  token?: string | null
}>()

/**
 * The assistants we write steps for. Order = tab order; the first is the default.
 * Steps follow the getautomata.app/blog guides for each one.
 */
const AGENTS = ['claude', 'grok', 'muse', 'chatgpt', 'other'] as const
type Agent = typeof AGENTS[number]

const AGENT_LABELS: Record<Agent, string> = {
  claude: 'Claude',
  grok: 'Grok Bot',
  muse: 'Meta Muse',
  chatgpt: 'ChatGPT',
  other: 'Other',
}

/**
 * The last tab picked, so the next token opens on the same assistant. Browser
 * storage only: a convenience, nothing depends on it. useLocalStorage swallows
 * a storage that throws (private window, blocked site data) and keeps the
 * default; an unknown stored value (renamed tab) also falls back to Claude.
 */
const stored = useLocalStorage<string>('automata:connect-agent', 'claude')
const agent = computed<Agent>({
  get: () => (AGENTS as readonly string[]).includes(stored.value) ? stored.value as Agent : 'claude',
  set: (value) => { stored.value = value },
})

const { origin, connectorUrl, bearerUrl } = useConnectorUrl()

const known = computed(() => Boolean(props.token))
const url = computed(() => connectorUrl(props.token))
const tokenValue = computed(() => props.token || MASKED_TOKEN)
const authHeader = computed(() => `Authorization: Bearer ${tokenValue.value}`)
/**
 * What Claude.ai's Request headers field takes: it sends the value exactly as
 * typed, adding no scheme, so the value carries `Bearer ` itself.
 */
const headerValue = computed(() => `Bearer ${tokenValue.value}`)
// The CLI needs a name for the server. The kind itself, so no connector is added
// to Claude Code under another kind's name. Header, not the token URL: the URL
// ends up in client config, history and logs.
const cliCommand = computed(() =>
  `claude mcp add --transport http ${props.kind} ${bearerUrl.value} --header "Authorization: Bearer ${tokenValue.value}"`)

/**
 * What the connector is called in the assistant, and the read-only first prompt
 * that proves it works — each kind's status tool.
 */
const kindCopy = computed(() => {
  switch (props.kind) {
    case 'whatsapp':
      return { name: 'Automata WhatsApp', tryPrompt: 'Use Automata WhatsApp to check the WhatsApp connection status.' }
    case 'telegram':
      return { name: 'Automata Telegram', tryPrompt: 'Use Automata Telegram to check the Telegram connection status.' }
    case 'postgres':
      return { name: 'Automata Postgres', tryPrompt: 'Use Automata Postgres to list the tables you can see.' }
    case 'imap':
      return { name: 'Automata Mail', tryPrompt: 'Use Automata Mail to check the mailbox status.' }
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

/**
 * What Grok Bot and Meta Muse are told in chat. Carries the endpoint, never the
 * token: the key goes into their secure credentials prompt, not the transcript.
 */
const grokMessage = computed(() => [
  'Add a custom MCP server and connect to it.',
  `Name: ${kindCopy.value.name}`,
  `URL: ${bearerUrl.value}`,
  'Auth: API key sent in the Authorization header as Bearer',
].join('\n'))

const museMessage = computed(() => [
  'Create a Custom Connector for a new remote MCP server, then connect to it:',
  `Name: ${kindCopy.value.name}`,
  'Transport: remote streamable HTTP',
  `URL: ${bearerUrl.value}`,
  'Auth: API key sent as Authorization: Bearer',
].join('\n'))

/**
 * Claude.ai, ChatGPT, Grok Bot and Muse connect from their own servers, so an
 * app URL on this machine or a private network is unreachable for them. Worth
 * saying, since the failure there is a vague "couldn't connect".
 */
const localOrigin = computed(() => {
  try {
    const host = new URL(origin.value).hostname
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]'
      || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  }
  catch {
    return false
  }
})
</script>

<template>
  <div class="min-w-0 space-y-4">
    <Tabs v-model="agent" class="min-w-0 gap-4">
      <TabsList class="h-auto w-full flex-wrap">
        <TabsTrigger v-for="key in AGENTS" :key="key" :value="key">
          {{ AGENT_LABELS[key] }}
        </TabsTrigger>
      </TabsList>

      <p
        v-if="localOrigin && agent !== 'other'"
        class="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground"
      >
        {{ agent === 'claude' ? 'Claude.ai' : AGENT_LABELS[agent] }} connects from its own
        servers, so it cannot reach <code class="font-mono">{{ origin }}</code>. Use a public
        HTTPS address for this app{{ agent === 'claude' ? ', or Claude Code below, which runs on your machine' : '' }}.
      </p>

      <TabsContent value="claude" class="min-w-0 space-y-4">
        <div class="space-y-2">
          <h3 class="text-sm font-semibold">
            Claude.ai and Claude Desktop
          </h3>
          <ol class="list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
            <li>Open <strong class="font-semibold">Settings → Customize → Connectors</strong>.</li>
            <li>Click <strong class="font-semibold">Add → Add custom connector</strong>.</li>
            <li>
              <p class="mb-2">
                Name it <strong class="font-semibold">{{ kindCopy.name }}</strong> and paste this URL:
              </p>
              <CopyableSnippet :value="bearerUrl" aria-label="Copy connector URL" />
            </li>
            <li>
              <p class="mb-2">
                Set authentication to <strong class="font-semibold">No sign-in</strong>. Under
                <strong class="font-semibold">Request headers</strong>, add one header:
              </p>
              <Label>Name</Label>
              <CopyableSnippet value="Authorization" aria-label="Copy header name" class="mb-2" />
              <Label>Value</Label>
              <CopyableSnippet :value="headerValue" :copyable="known" aria-label="Copy header value" />
            </li>
            <li>Click <strong class="font-semibold">Add</strong>, then turn the connector on from the tools menu in a chat.</li>
          </ol>
          <p class="text-xs text-muted-foreground">
            In a Team or Enterprise organization, an Owner adds the connector and every member
            uses this one token, so they all act as its holder.
          </p>
          <div class="min-w-0 space-y-2 rounded-md border bg-muted/40 p-3">
            <p class="text-sm">
              <strong class="font-semibold">No Request headers section?</strong> Claude is still
              rolling it out. Paste this URL in step 3 instead and skip step 4 — the token
              travels in the URL:
            </p>
            <CopyableSnippet :value="url" :copyable="known" aria-label="Copy connector URL with token" />
          </div>
        </div>
        <Separator />
        <div class="min-w-0 space-y-2">
          <h3 class="text-sm font-semibold">
            Claude Code
          </h3>
          <p class="text-sm">
            Run this in your project. Add <code class="font-mono">--scope user</code> to
            make it available in every project instead.
          </p>
          <CopyableSnippet :value="cliCommand" :copyable="known" wrap aria-label="Copy command" />
          <p class="text-xs text-muted-foreground">
            Confirm it registered with <code class="font-mono">claude mcp list</code>.
          </p>
        </div>
      </TabsContent>

      <TabsContent value="grok" class="min-w-0">
        <ol class="list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
          <li>
            <p class="mb-2">
              Grok Bot has no settings page for this — you ask it in a chat. Send this message:
            </p>
            <CopyableSnippet :value="grokMessage" wrap aria-label="Copy message for Grok Bot" />
          </li>
          <li>
            <p class="mb-2">
              When it asks for the key, paste the token into its secure prompt —
              never into the chat itself:
            </p>
            <CopyableSnippet :value="tokenValue" :copyable="known" aria-label="Copy token" />
          </li>
          <li>Wait for <strong class="font-semibold">Secrets Saved</strong>. Grok Bot then says it is connected and lists the tools it found.</li>
        </ol>
      </TabsContent>

      <TabsContent value="muse" class="min-w-0 space-y-3">
        <ol class="list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
          <li>
            <p class="mb-2">
              Muse has no “add server” button — you ask it in a chat. Send this message:
            </p>
            <CopyableSnippet :value="museMessage" wrap aria-label="Copy message for Meta Muse" />
          </li>
          <li>
            <p class="mb-2">
              When it asks for the key, paste the token into its secure credentials
              prompt — never into the chat itself:
            </p>
            <CopyableSnippet :value="tokenValue" :copyable="known" aria-label="Copy token" />
            <p class="mt-2 text-xs text-muted-foreground">
              If Muse offers only OAuth, ask it to use an API key sent as a bearer token instead.
            </p>
          </li>
          <li>Muse tests the connector and lists its tools. Review or remove it later under <strong class="font-semibold">Settings → Connectors</strong>.</li>
        </ol>
        <p class="text-xs text-muted-foreground">
          Meta is still rolling out custom connectors. If Muse says it cannot create one, try again later.
        </p>
      </TabsContent>

      <TabsContent value="chatgpt" class="min-w-0 space-y-3">
        <ol class="list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
          <li>
            On chatgpt.com (not the mobile app), open <strong class="font-semibold">Plugins</strong>
            — in some accounts <strong class="font-semibold">Settings → Apps</strong> — and choose
            <strong class="font-semibold">Add custom MCP server</strong>.
          </li>
          <li>
            <p class="mb-2">
              Name it <strong class="font-semibold">{{ kindCopy.name }}</strong> and paste this as the server URL:
            </p>
            <CopyableSnippet :value="url" :copyable="known" aria-label="Copy connector URL" />
          </li>
          <li>
            Set authentication to <strong class="font-semibold">No authentication</strong> —
            the token is already in the URL.
          </li>
          <li>Tick <strong class="font-semibold">I understand and want to continue</strong>, then <strong class="font-semibold">Create as a plugin</strong>.</li>
          <li>In a new chat, type <code class="font-mono">@</code> and pick the plugin.</li>
        </ol>
        <p class="text-xs text-muted-foreground">
          In a Business, Enterprise or Edu workspace an admin may have to allow custom MCP servers first.
        </p>
      </TabsContent>

      <TabsContent value="other" class="min-w-0 space-y-4">
        <div class="min-w-0 space-y-2">
          <h3 class="text-sm font-semibold">
            Clients that can set request headers (recommended)
          </h3>
          <p class="text-sm">
            The token travels in the header, so it stays out of the URL, the client's settings
            and its logs. Point the client at the plain endpoint.
          </p>
          <Label>Endpoint</Label>
          <CopyableSnippet :value="bearerUrl" aria-label="Copy endpoint URL" />
          <Label>Header</Label>
          <CopyableSnippet :value="authHeader" :copyable="known" aria-label="Copy authorization header" />
          <Label>Token on its own</Label>
          <CopyableSnippet :value="tokenValue" :copyable="known" aria-label="Copy token" />
        </div>
        <div class="min-w-0 space-y-2">
          <h3 class="text-sm font-semibold">
            Clients that take only a URL
          </h3>
          <p class="text-sm">
            The token is part of this URL, so treat the whole URL as a password.
          </p>
          <CopyableSnippet :value="url" :copyable="known" aria-label="Copy connector URL" />
        </div>
        <div class="min-w-0 space-y-2">
          <h3 class="text-sm font-semibold">
            Testing by hand
          </h3>
          <p class="text-sm">
            Run the MCP Inspector and point it at either form above:
          </p>
          <CopyableSnippet value="pnpm dlx @modelcontextprotocol/inspector" aria-label="Copy inspector command" />
        </div>
      </TabsContent>
    </Tabs>

    <div class="min-w-0 space-y-2">
      <p class="text-sm text-muted-foreground">
        Then try a read-only first prompt:
      </p>
      <CopyableSnippet :value="kindCopy.tryPrompt" wrap aria-label="Copy first prompt" />
    </div>
  </div>
</template>
