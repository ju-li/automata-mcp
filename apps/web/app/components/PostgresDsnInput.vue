<script setup lang="ts">
/**
 * A Postgres connection string, typed whole or assembled from its parts.
 *
 * The model is always a DSN: the server has exactly one way in (`describeDsn` →
 * host guard → probe), and composing here keeps it that way rather than adding
 * a second parser for a second shape of the same secret.
 *
 * Each tab keeps its own state and the model follows the active one. Nothing is
 * copied between them — filling the connection-string field from the parameters
 * would put the password on screen in clear.
 */
const props = defineProps<{ idPrefix: string }>()
const dsn = defineModel<string>({ required: true })

type Mode = 'dsn' | 'params'
type SslMode = 'require' | 'verify-full' | 'disable'

const mode = ref<Mode>('dsn')
const raw = ref(dsn.value)
const host = ref('')
const port = ref('')
const database = ref('')
const user = ref('')
const password = ref('')
const sslMode = ref<SslMode>('require')

/**
 * `''` until the parts the server would refuse without are there, so the
 * caller's "can submit" check needs no knowledge of which tab is open. Every
 * part is percent-encoded — a password holding `@`, `/` or `:` is the reason
 * people get a hand-built URL wrong.
 */
const composed = computed(() => {
  const h = host.value.trim()
  const db = database.value.trim()
  const u = user.value.trim()
  if (!h || !db || !u) return ''

  // An IPv6 literal needs brackets, or its colons read as the port separator.
  const hostPart = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
  const auth = password.value
    ? `${encodeURIComponent(u)}:${encodeURIComponent(password.value)}`
    : encodeURIComponent(u)
  const p = port.value.trim() || '5432'

  return `postgresql://${auth}@${hostPart}:${p}/${encodeURIComponent(db)}?sslmode=${sslMode.value}`
})

watchEffect(() => {
  dsn.value = mode.value === 'dsn' ? raw.value : composed.value
})

const id = (field: string) => `${props.idPrefix}-${field}`

/**
 * The host the active tab names, lower-cased, for hints only — the server
 * parses for real, and nothing here decides what is accepted. Split the way
 * the server's `assertDriverAgrees` reads an authority: user info ends at the
 * last `@`.
 */
const typedHost = computed(() => {
  if (mode.value === 'params') return host.value.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const value = raw.value.trim()
  const start = value.indexOf('://')
  if (start === -1) return ''
  const authority = value.slice(start + 3).split(/[/?#]/)[0] ?? ''
  return authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase()
})

/**
 * Supabase's direct host (`db.<ref>.supabase.co`) resolves only to IPv6, and a
 * server with no outbound IPv6 — Railway among them — fails it with
 * ENETUNREACH. A hint, not a refusal: a deployment that has IPv6 reaches it
 * fine. `docs/postgres.md` "Supabase" says the same.
 */
const supabaseDirect = computed(() => /^db\.[a-z0-9]+\.supabase\.co$/.test(typedHost.value))
</script>

<template>
  <Tabs v-model="mode" class="gap-3">
    <TabsList class="w-full">
      <TabsTrigger value="dsn">
        Connection string
      </TabsTrigger>
      <TabsTrigger value="params">
        Parameters
      </TabsTrigger>
    </TabsList>

    <TabsContent value="dsn" class="space-y-2">
      <Label :for="id('dsn')">Connection string</Label>
      <Input
        :id="id('dsn')"
        v-model="raw"
        autocomplete="off"
        spellcheck="false"
        placeholder="postgres://user:password@host:5432/database"
      />
    </TabsContent>

    <TabsContent value="params" class="space-y-3">
      <div class="grid grid-cols-[1fr_6rem] gap-3">
        <div class="space-y-2">
          <Label :for="id('host')">Host</Label>
          <Input
            :id="id('host')"
            v-model="host"
            autocomplete="off"
            spellcheck="false"
            placeholder="db.example.com"
          />
        </div>
        <div class="space-y-2">
          <Label :for="id('port')">Port</Label>
          <Input
            :id="id('port')"
            v-model="port"
            inputmode="numeric"
            autocomplete="off"
            placeholder="5432"
          />
        </div>
      </div>

      <div class="space-y-2">
        <Label :for="id('database')">Database</Label>
        <Input
          :id="id('database')"
          v-model="database"
          autocomplete="off"
          spellcheck="false"
          placeholder="postgres"
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-2">
          <Label :for="id('user')">User</Label>
          <Input
            :id="id('user')"
            v-model="user"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="space-y-2">
          <Label :for="id('password')">Password</Label>
          <Input
            :id="id('password')"
            v-model="password"
            type="password"
            autocomplete="new-password"
          />
        </div>
      </div>

      <div class="space-y-2">
        <Label :for="id('ssl')">SSL mode</Label>
        <Select v-model="sslMode">
          <SelectTrigger :id="id('ssl')" class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="require">
              Require — encrypted, certificate not checked
            </SelectItem>
            <SelectItem value="verify-full">
              Verify full — encrypted, certificate checked
            </SelectItem>
            <SelectItem value="disable">
              Disable — no encryption
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </TabsContent>

    <p v-if="supabaseDirect" class="text-xs text-amber-700 dark:text-amber-400">
      Supabase direct connections are IPv6-only and may be unreachable from this server.
      Paste the Session pooler string instead: in Supabase, open Connect, then Session pooler.
    </p>
  </Tabs>
</template>
