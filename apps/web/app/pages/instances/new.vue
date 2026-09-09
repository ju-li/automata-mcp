<script setup lang="ts">
import { DatabaseIcon, MessageCircleIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * Pick a kind, then fill in that kind's form.
 *
 * Creating happens on an explicit click, not on mount. Provisioning a WhatsApp
 * account reserves a live socket on the Evolution server, so a page refresh must
 * not silently create a second one — and a database connection is proved by
 * actually connecting, which is not something a refresh should re-do either.
 */
type Kind = 'whatsapp' | 'postgres'

const kind = ref<Kind | undefined>()
const label = ref('')
const busy = ref(false)

// WhatsApp: bring-your-own Evolution server. All or nothing — half of it is not
// completed from our configuration, see evolutionAdminCredentials().
const ownServer = ref(false)
const serverUrl = ref('')
const serverKey = ref('')

// Postgres
const dsn = ref('')

const canSubmit = computed(() => {
  if (busy.value) return false
  if (kind.value === 'postgres') return dsn.value.trim().length > 0
  if (kind.value === 'whatsapp') {
    if (!ownServer.value) return true
    return serverUrl.value.trim().length > 0 && serverKey.value.trim().length > 0
  }
  return false
})

async function create() {
  if (!canSubmit.value) return
  busy.value = true

  const body = kind.value === 'postgres'
    ? { kind: 'postgres', label: label.value, dsn: dsn.value.trim() }
    : {
        kind: 'whatsapp',
        label: label.value,
        ...(ownServer.value && {
          server: { baseUrl: serverUrl.value.trim(), adminKey: serverKey.value.trim() },
        }),
      }

  try {
    const { instance } = await $fetch<{ instance: { id: string } }>('/api/instances', {
      method: 'POST',
      body,
    })
    await navigateTo(`/instances/${instance.id}`)
  }
  catch (err: any) {
    // The server's message is the useful part here — it names the bad host, the
    // refused address or the connection error — so show it rather than a generic.
    toast.error(err?.data?.message || err?.data?.statusMessage || 'Could not create the connection')
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-md space-y-6">
    <div>
      <h1 class="font-heading text-2xl font-semibold">
        Add a connection
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Each connection gets its own Claude connector, and each connector token
        reaches exactly one connection.
      </p>
    </div>

    <!-- ── kind ─────────────────────────────────────────────────────────── -->
    <div v-if="!kind" class="grid gap-3">
      <button
        type="button"
        class="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
        @click="kind = 'whatsapp'"
      >
        <MessageCircleIcon class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <span>
          <span class="block font-medium">WhatsApp account</span>
          <span class="block text-sm text-muted-foreground">
            Pair a phone by scanning a QR code. Claude can read and send messages.
          </span>
        </span>
      </button>

      <button
        type="button"
        class="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
        @click="kind = 'postgres'"
      >
        <DatabaseIcon class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <span>
          <span class="block font-medium">PostgreSQL database</span>
          <span class="block text-sm text-muted-foreground">
            Point Claude at a database with a connection string. Read-only by default.
          </span>
        </span>
      </button>
    </div>

    <!-- ── the form for the chosen kind ─────────────────────────────────── -->
    <template v-else>
      <Card>
        <CardContent class="space-y-4 pt-6">
          <div class="space-y-2">
            <Label for="label">Name this connection</Label>
            <Input
              id="label"
              v-model="label"
              :placeholder="kind === 'postgres' ? 'Production analytics' : 'Work phone'"
              @keydown.enter="create"
            />
            <p class="text-xs text-muted-foreground">
              Just for you — it helps when you have more than one.
            </p>
          </div>

          <!-- Postgres -->
          <template v-if="kind === 'postgres'">
            <Separator />
            <div class="space-y-2">
              <Label for="dsn">Connection string</Label>
              <Input
                id="dsn"
                v-model="dsn"
                autocomplete="off"
                spellcheck="false"
                placeholder="postgres://user:password@host:5432/database"
              />
              <p class="text-xs text-muted-foreground">
                Checked by actually connecting before it is saved, and never shown
                again afterwards. It is stored so this app can reconnect, so treat
                the password in it as one this server holds.
              </p>
            </div>
          </template>

          <!-- WhatsApp -->
          <template v-else>
            <Separator />
            <div class="flex items-start gap-2">
              <Checkbox
                id="own-server"
                :model-value="ownServer"
                @update:model-value="value => ownServer = value === true"
              />
              <div class="space-y-1">
                <Label for="own-server" class="font-normal">
                  Use my own Evolution API server
                </Label>
                <p class="text-xs text-muted-foreground">
                  Leave this off to use the server this app is configured with.
                </p>
              </div>
            </div>

            <div v-if="ownServer" class="space-y-4 rounded-md border p-3">
              <div class="space-y-2">
                <Label for="server-url">Server URL</Label>
                <Input
                  id="server-url"
                  v-model="serverUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://evolution.example.com"
                />
              </div>
              <div class="space-y-2">
                <Label for="server-key">Global API key</Label>
                <Input
                  id="server-key"
                  v-model="serverKey"
                  type="password"
                  autocomplete="off"
                  placeholder="AUTHENTICATION_API_KEY"
                />
                <p class="text-xs text-muted-foreground">
                  This is your server's <span class="font-mono">AUTHENTICATION_API_KEY</span>.
                  It can create and delete instances on that server, so it is a
                  wider secret than the per-account token this app normally holds.
                </p>
              </div>
            </div>
          </template>

          <Button class="w-full" :disabled="!canSubmit" @click="create">
            <template v-if="busy">
              {{ kind === 'postgres' ? 'Connecting…' : 'Setting up…' }}
            </template>
            <template v-else>
              {{ kind === 'postgres' ? 'Connect database' : 'Continue to QR code' }}
            </template>
          </Button>

          <Button variant="ghost" class="w-full" :disabled="busy" @click="kind = undefined">
            Back
          </Button>
        </CardContent>
      </Card>

      <div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <template v-if="kind === 'postgres'">
          <p class="font-medium">
            Connect with a role that can do only what you need.
          </p>
          <p class="mt-1 text-muted-foreground">
            Per-token table allowlists keep Claude inside the tables you choose,
            but the real boundary is the database role: a role that can read
            everything can be talked into reading everything. Create a role with
            <span class="font-mono">GRANT SELECT</span> on just the tables you
            want, and use that here.
          </p>
        </template>
        <template v-else>
          <p class="font-medium">
            Use a phone number you can dedicate to this.
          </p>
          <p class="mt-1 text-muted-foreground">
            Pairing links a real WhatsApp account. Repeatedly pairing and
            unpairing a number, or sending unsolicited messages from a freshly
            paired one, can get it banned by WhatsApp.
          </p>
        </template>
      </div>
    </template>
  </div>
</template>
