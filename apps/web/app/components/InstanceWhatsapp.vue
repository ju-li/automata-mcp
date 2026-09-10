<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { ArrowLeftIcon, MessagesSquareIcon, SmartphoneIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * The pairing-and-dashboard panel for a WhatsApp connection. Chosen by
 * pages/instances/[id].vue from the connection's kind; everything in here
 * assumes Evolution and a phone, which is why it is not the page itself.
 */
const props = defineProps<{ id: string }>()

interface StatusResponse {
  instance: { id: string, name: string, label: string, ownServer?: boolean, canReadMessages?: boolean }
  state: ConnectionState
  profileName?: string
  profilePicUrl?: string
  number?: string
  stats: { messages: number, chats: number, contacts: number }
}

interface QrResponse {
  state: ConnectionState
  qr?: { base64?: string, code?: string, pairingCode?: string, count?: number }
}

const id = computed(() => props.id)

const { data, refresh } = await useFetch<StatusResponse>(() => `/api/instances/${id.value}`)

/**
 * The QR poll reports state far more often than the status fetch does, so it is
 * the fresher source while pairing. Without this the badge sits on
 * "Disconnected" the whole time a QR is on screen.
 */
const polledState = ref<ConnectionState | null>(null)

const state = computed<ConnectionState>(() => polledState.value ?? data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')
const display = computed(() => describeState(state.value))

const qr = ref<QrResponse['qr'] | null>(null)
const pairingTimedOut = ref(false)
const pairingStartedAt = ref(Date.now())
const busy = ref(false)
const deleteConfirm = ref('')

// Reading goes to Evolution's own Postgres, so an account on a server the user
// supplied needs that server's database URL. Surfaced here because otherwise the
// first sign of it is a tool returning 501 mid-conversation.
const needsDbUrl = computed(() =>
  data.value?.instance.ownServer === true && data.value?.instance.canReadMessages === false,
)
const dbUrl = ref('')
const savingDbUrl = ref(false)

async function saveDbUrl() {
  if (!dbUrl.value.trim()) return
  savingDbUrl.value = true
  try {
    await $fetch(`/api/instances/${id.value}/evolution-db`, {
      method: 'PATCH',
      body: { dbUrl: dbUrl.value.trim() },
    })
    dbUrl.value = ''
    await refresh()
    toast.success('Claude can now read and search this account\'s messages.')
  }
  catch (err: any) {
    // The server's message names the actual failure — wrong database, refused
    // host, missing SELECT — so it is worth more than a generic here.
    toast.error(err?.data?.message || err?.data?.statusMessage || 'Could not save the database connection string')
  }
  finally {
    savingDbUrl.value = false
  }
}
const chatsOpen = ref(false)

// ── pairing ────────────────────────────────────────────────────────────────
// Polling the QR endpoint is what drives pairing: Evolution starts the
// connection the first time it is asked for a QR on a disconnected instance.
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000

const { pause: pauseQrPoll, resume: resumeQrPoll } = useIntervalFn(async () => {
  if (connected.value) return

  if (Date.now() - pairingStartedAt.value > PAIRING_TIMEOUT_MS) {
    pairingTimedOut.value = true
    pauseQrPoll()
    return
  }

  try {
    const result = await $fetch<QrResponse>(`/api/instances/${id.value}/qr`)
    polledState.value = result.state
    if (result.state === 'open') {
      qr.value = null
      await refresh()
      return
    }
    // Keep the previous QR while Evolution generates the next one, so the image
    // does not flicker between polls.
    if (result.qr?.base64) qr.value = result.qr
  }
  catch {
    // Transient. The next tick retries; a hard failure surfaces on the status poll.
  }
}, 2000, { immediate: false })

// ── connected status ───────────────────────────────────────────────────────
const { pause: pauseStatusPoll, resume: resumeStatusPoll } = useIntervalFn(
  () => refresh(),
  15000,
  { immediate: false },
)

watch(connected, (isConnected) => {
  if (isConnected) {
    polledState.value = null
    pauseQrPoll()
    resumeStatusPoll()
  }
  else {
    pauseStatusPoll()
    resumeQrPoll()
  }
})

onMounted(() => {
  if (connected.value) resumeStatusPoll()
  else resumeQrPoll()
})

function restartPairing() {
  pairingTimedOut.value = false
  pairingStartedAt.value = Date.now()
  resumeQrPoll()
}

// ── actions ────────────────────────────────────────────────────────────────
async function disconnect() {
  busy.value = true
  try {
    await $fetch(`/api/instances/${id.value}/logout`, { method: 'POST' })
    qr.value = null
    polledState.value = null
    restartPairing()
    await refresh()
    toast.success('Disconnected. Scan the new QR code to reconnect.')
  }
  catch {
    toast.error('Could not disconnect')
  }
  finally {
    busy.value = false
  }
}

/**
 * Arm a full-history import. Signs the device out — WhatsApp only hands history
 * over when a device is linked, so the import rides in on the next QR scan.
 */
async function importHistory() {
  busy.value = true
  try {
    await $fetch(`/api/instances/${id.value}/resync`, { method: 'POST' })
    qr.value = null
    polledState.value = null
    restartPairing()
    await refresh()
    toast.success('Scan the new QR code — your history imports as it connects.')
  }
  catch {
    toast.error('Could not start the history import')
  }
  finally {
    busy.value = false
  }
}

async function destroy() {
  busy.value = true
  try {
    await $fetch(`/api/instances/${id.value}`, { method: 'DELETE' })
    toast.success('Account removed')
    await navigateTo('/instances')
  }
  catch {
    toast.error('Could not remove the account')
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <NuxtLink to="/instances" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon class="size-4" />
        All connections
      </NuxtLink>

      <div class="mt-2 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="truncate font-heading text-2xl font-semibold">
            {{ data?.instance.label }}
          </h1>
          <p class="text-sm text-muted-foreground">
            {{ display.hint }}
          </p>
        </div>
        <ConnectionBadge :state="state" />
      </div>
    </div>

    <!-- ── pairing ─────────────────────────────────────────────────────── -->
    <Card v-if="!connected">
      <CardHeader>
        <CardTitle>Scan to connect</CardTitle>
        <CardDescription>
          On your phone: WhatsApp → Settings → Linked devices → Link a device.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col items-center gap-4 pb-8">
        <div class="flex size-64 items-center justify-center rounded-lg border bg-white p-2">
          <img v-if="qr?.base64" :src="qr.base64" alt="WhatsApp pairing QR code" class="size-full">
          <Skeleton v-else-if="!pairingTimedOut" class="size-full" />
          <SmartphoneIcon v-else class="size-10 text-muted-foreground" />
        </div>

        <p v-if="qr?.pairingCode" class="text-sm text-muted-foreground">
          Or enter code <code class="font-mono font-medium">{{ qr.pairingCode }}</code> on your phone.
        </p>

        <div v-if="pairingTimedOut" class="text-center">
          <p class="text-sm text-muted-foreground">
            The code expired.
          </p>
          <Button variant="outline" size="sm" class="mt-2" @click="restartPairing">
            Show a new code
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- ── connected ───────────────────────────────────────────────────── -->
    <template v-else>
      <Card>
        <CardContent class="flex items-center gap-4 pt-6">
          <img
            v-if="data?.profilePicUrl"
            :src="data.profilePicUrl"
            alt=""
            class="size-12 rounded-full object-cover"
          >
          <div class="min-w-0">
            <p class="truncate font-medium">
              {{ data?.profileName || 'WhatsApp' }}
            </p>
            <p class="truncate text-sm text-muted-foreground tabular-nums">
              {{ data?.number || '—' }}
            </p>
          </div>
        </CardContent>
      </Card>

      <div class="grid gap-4 sm:grid-cols-3">
        <StatCard label="Messages" :value="data?.stats.messages ?? 0" />
        <StatCard
          label="Chats"
          :value="data?.stats.chats ?? 0"
          :icon="MessagesSquareIcon"
          clickable
          @click="chatsOpen = true"
        />
        <StatCard label="Contacts" :value="data?.stats.contacts ?? 0" />
      </div>

      <ChatsDialog
        v-model:open="chatsOpen"
        :instance-id="id"
        :total="data?.stats.chats ?? 0"
      />

      <p class="text-xs text-muted-foreground">
        WhatsApp hands over its history only at the moment a device is linked, so
        these counts are the import from pairing plus everything since. If an old
        conversation is missing, re-import it under Manage.
      </p>
    </template>

    <Separator />

    <!--
      Always shown, including while disconnected. Hiding it would mean you
      cannot revoke a token for an account that is offline — which is exactly
      when you are most likely to want to.
    -->
    <!--
      Shown only for an account on the user's own Evolution server that has no
      database URL yet. Reading is the one capability missing, and it is not
      obvious why, so the card says what and why rather than just offering a
      field.
    -->
    <div v-if="needsDbUrl" class="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div>
        <p class="text-sm font-medium">
          Claude cannot read this account's messages yet
        </p>
        <p class="mt-1 text-sm text-muted-foreground">
          Reading and searching go to your Evolution server's own Postgres, because
          Evolution's API cannot search message content. This app has the server's
          URL but not its database. Pairing, listing chats and sending already work.
        </p>
      </div>

      <div class="space-y-2">
        <Label for="db-url">Database connection string</Label>
        <Input
          id="db-url"
          v-model="dbUrl"
          autocomplete="off"
          spellcheck="false"
          placeholder="postgres://reader:password@host:5432/evolution"
          @keydown.enter="saveDbUrl"
        />
        <p class="text-xs text-muted-foreground">
          Checked against your database before it is saved. A
          <span class="font-mono">SELECT</span>-only role is enough — this app never
          writes to it.
        </p>
      </div>

      <Button size="sm" :disabled="savingDbUrl || !dbUrl.trim()" @click="saveDbUrl">
        {{ savingDbUrl ? 'Checking…' : 'Enable reading' }}
      </Button>
    </div>

    <McpTokens :instance-id="id" kind="whatsapp" :connected="connected" />

    <Separator />

    <!-- ── controls ────────────────────────────────────────────────────── -->
    <section class="space-y-4">
      <h2 class="font-heading text-lg font-semibold">
        Manage
      </h2>

      <div class="flex flex-wrap gap-3">
        <AlertDialog v-if="connected">
          <AlertDialogTrigger as-child>
            <Button variant="outline" :disabled="busy">
              Disconnect
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
              <AlertDialogDescription>
                WhatsApp signs this device out. Your tokens and message history are
                kept, but nothing can send or receive until you scan a new QR code
                with the same phone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction @click="disconnect">
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button variant="outline" :disabled="busy">
              Import full history
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Import this account's full history?</AlertDialogTitle>
              <AlertDialogDescription>
                WhatsApp only hands over past conversations while a device is being
                linked, so this signs the device out and imports as you scan a new
                QR code with the same phone. Nothing already stored is lost, and
                nothing can send or receive until the scan completes. Repeatedly
                linking and unlinking a number risks it being banned by WhatsApp.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction @click="importHistory">
                Disconnect and import
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button variant="destructive" :disabled="busy">
              Remove account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove “{{ data?.instance.label }}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes the connection, every message and chat
                stored for it, and every connector token issued for it. Claude will
                immediately lose access. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div class="space-y-2">
              <Label for="confirm">Type <span class="font-mono">delete</span> to confirm</Label>
              <Input id="confirm" v-model="deleteConfirm" autocomplete="off" />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel @click="deleteConfirm = ''">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                :disabled="deleteConfirm !== 'delete' || busy"
                @click="destroy"
              >
                Remove permanently
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  </div>
</template>
