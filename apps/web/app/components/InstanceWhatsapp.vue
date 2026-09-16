<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { ArrowLeftIcon, MessagesSquareIcon, SmartphoneIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * The pairing-and-dashboard panel for a WhatsApp connection. Chosen by
 * pages/instances/[id].vue from the connection's kind; everything in here
 * assumes Evolution and a phone, which is why it is not the page itself.
 */
const props = withDefaults(defineProps<{
  id: string
  /**
   * Whether this viewer may change the connection, as opposed to use it.
   *
   * Decided by the server and passed down from the page. It gates presentation
   * only — every control it hides is independently refused with a 403.
   */
  canManage?: boolean
}>(), { canManage: false })

interface StatusResponse {
  instance: PublicInstanceRow
  state: ConnectionState
  /** Was connected, and Evolution's live socket no longer is. */
  sessionLost?: boolean
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

/**
 * Set by Disconnect and Import full history. Both end the session on purpose,
 * and for a moment afterwards Evolution's stored status still says `open` —
 * which is exactly what a dropped session looks like. Without this the page
 * would offer to reconnect the account it was just told to sign out.
 */
const pairingRequested = ref(false)

/**
 * What this page is showing. A lost session is its own mode rather than a
 * flavour of pairing: its phone is still linked, so the instruction is
 * different, and it must not be polled the way pairing is — see `applyMode`.
 */
type Mode = 'pairing' | 'lost' | 'connected'

/**
 * **A member never enters pairing mode**, and that is a safety property rather
 * than a tidiness one. Pairing mode runs the QR poll, and the QR poll calls
 * `/instance/connect` — which a member is refused with a 403 anyway, so for them
 * it would be a failing request every two seconds forever. Pairing is
 * management: scanning a code binds a real phone number, and someone who cannot
 * press Reconnect or Disconnect has no business being shown a QR either.
 *
 * They get the `lost` wording instead, minus the button, which is the honest
 * description of what they are looking at: a connection that is not currently
 * usable and that somebody else has to fix.
 */
const mode = computed<Mode>(() => {
  if (connected.value) return 'connected'
  if (!props.canManage) return 'lost'
  if (data.value?.sessionLost && !pairingRequested.value) return 'lost'
  return 'pairing'
})

const display = computed(() => describeState(state.value, 'whatsapp', { lost: mode.value === 'lost' }))

const qr = ref<QrResponse['qr'] | null>(null)
const pairingTimedOut = ref(false)
const pairingStartedAt = ref(Date.now())

const { busy, run } = useApiAction()
const { busy: savingDbUrl, run: runSaveDbUrl } = useApiAction()
const { busy: reconnectBusy, run: runReconnect } = useApiAction()

// Reading goes to Evolution's own Postgres, so an account on a server the user
// supplied needs that server's database URL. Surfaced here because otherwise the
// first sign of it is a tool returning 501 mid-conversation.
const needsDbUrl = computed(() =>
  data.value?.instance.ownServer === true && data.value?.instance.canReadMessages === false,
)
const dbUrl = ref('')

async function saveDbUrl() {
  if (!dbUrl.value.trim()) return

  await runSaveDbUrl(
    async () => {
      await $fetch(`/api/instances/${id.value}/evolution-db`, {
        method: 'PATCH',
        body: { dbUrl: dbUrl.value.trim() },
      })
      dbUrl.value = ''
      await refresh()
    },
    {
      success: 'Claude can now read and search this account\'s messages.',
      // The server's message names the actual failure — wrong database, refused
      // host, missing SELECT — so it is worth more than a generic here.
      failure: 'Could not save the database connection string',
    },
  )
}
const chatsOpen = ref(false)

// ── pairing ────────────────────────────────────────────────────────────────
// Polling the QR endpoint is what drives pairing: Evolution starts the
// connection the first time it is asked for a QR on a disconnected instance.
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000

const { pause: pauseQrPoll, resume: resumeQrPoll } = useIntervalFn(async () => {
  if (mode.value !== 'pairing') return

  if (Date.now() - pairingStartedAt.value > PAIRING_TIMEOUT_MS) {
    pairingTimedOut.value = true
    pauseQrPoll()
    return
  }

  try {
    const result = await $fetch<QrResponse>(`/api/instances/${id.value}/qr`)
    if (result.state === 'open') {
      qr.value = null
      // Refreshed rather than recorded, so the page does not flip to connected on
      // this poll's word and back again while the status fetch catches up.
      await refresh()
      return
    }
    polledState.value = result.state
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

// ── reconnecting ───────────────────────────────────────────────────────────
/**
 * How long to watch for the connection to come back after asking. Evolution
 * answers the request before the socket is up, and a healthy reconnect takes
 * seconds; a minute without one means it is not coming on its own.
 */
const RECONNECT_WATCH_MS = 60_000

const reconnecting = ref(false)
const reconnectStalled = ref(false)
const reconnectStartedAt = ref(0)

const { pause: pauseReconnectPoll, resume: resumeReconnectPoll } = useIntervalFn(async () => {
  await refresh()
  if (mode.value === 'lost' && Date.now() - reconnectStartedAt.value > RECONNECT_WATCH_MS) {
    pauseReconnectPoll()
    reconnecting.value = false
    reconnectStalled.value = true
  }
}, 3000, { immediate: false })

/**
 * Ask once, then watch. Three ways out, and only the last needs this function:
 * the session comes back (`applyMode` sees `connected`), the credentials were
 * rejected and Evolution shows a QR instead (`applyMode` sees `pairing`), or
 * nothing happens within the window and the page says so.
 */
async function reconnect() {
  reconnectStalled.value = false

  const asked = await runReconnect(
    async () => {
      await $fetch(`/api/instances/${id.value}/reconnect`, { method: 'POST' })
      return true
    },
    { failure: 'Could not reconnect this account' },
  )

  if (!asked) {
    reconnectStalled.value = true
    return
  }

  reconnecting.value = true
  reconnectStartedAt.value = Date.now()
  await refresh()
  if (mode.value === 'lost') resumeReconnectPoll()
}

// ── polling follows the mode ───────────────────────────────────────────────
/**
 * **The QR poll runs in pairing mode only, and that is load-bearing.** It calls
 * `/instance/connect`, which on an instance Evolution holds in `close` builds a
 * brand-new socket from the stored credentials. Pointed every two seconds at a
 * lost session Evolution cannot bring back, that is a fresh WhatsApp login every
 * two seconds — sockets leaked on the server, and the pattern that gets a
 * number banned. A lost session is reconnected once, when someone asks.
 *
 * The status poll runs whenever a session exists, lost included, so a recovery
 * Evolution makes on its own is noticed without anyone pressing anything.
 */
function applyMode(next: Mode) {
  if (next === 'pairing') {
    pauseStatusPoll()
    resumeQrPoll()
  }
  else {
    polledState.value = null
    pauseQrPoll()
    resumeStatusPoll()
  }

  if (next !== 'lost') {
    pauseReconnectPoll()
    reconnecting.value = false
    reconnectStalled.value = false
  }

  if (next === 'connected') pairingRequested.value = false
}

watch(mode, (next, previous) => {
  if (previous === 'lost' && next === 'connected' && reconnecting.value) {
    toast.success('Reconnected.')
  }
  applyMode(next)
})

onMounted(() => applyMode(mode.value))

function restartPairing() {
  pairingTimedOut.value = false
  pairingStartedAt.value = Date.now()
  resumeQrPoll()
}

// ── actions ────────────────────────────────────────────────────────────────
/**
 * Both controls here end the WhatsApp session and send the page back to
 * pairing, and both then need a QR: `logout` because that is all it does, and
 * `resync` because arming a history import only takes effect on a fresh device
 * link. So they differ in the endpoint they call and in what to tell the user,
 * and in nothing else.
 *
 * The failure text is a generic on purpose — these answer "Not found" or a bare
 * Evolution status, which is a worse thing to show someone than the sentence
 * below.
 */
function backToPairing(path: string, success: string, failure: string) {
  return run(
    async () => {
      await $fetch(`/api/instances/${id.value}/${path}`, { method: 'POST' })
      qr.value = null
      polledState.value = null
      pairingRequested.value = true
      restartPairing()
      await refresh()
    },
    { success, failure, preferServerMessage: false },
  )
}

const disconnect = () => backToPairing(
  'logout',
  'Disconnected. Scan the new QR code to reconnect.',
  'Could not disconnect',
)

/**
 * Arm a full-history import. Signs the device out — WhatsApp only hands history
 * over when a device is linked, so the import rides in on the next QR scan.
 */
const importHistory = () => backToPairing(
  'resync',
  'Scan the new QR code — your history imports as it connects.',
  'Could not start the history import',
)
</script>

<template>
  <div class="space-y-8">
    <div>
      <NuxtLink to="/instances" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon class="size-4" />
        All connections
      </NuxtLink>

      <div class="group/title mt-2 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <InstanceTitle
            :id="id"
            :label="data?.instance.label"
            :can-manage="canManage"
            @renamed="refresh()"
          />
          <!--
            `describeState`'s hints are written for someone who can act on them
            — "reconnect", "scan a QR code" — and a member can do neither. The
            banner below already says what is wrong and who fixes it, so for
            them the subtitle says what the connection *is* instead of issuing
            an instruction they cannot follow.
          -->
          <p class="text-sm text-muted-foreground">
            {{ canManage ? display.hint : `WhatsApp account · ${display.label.toLowerCase()}` }}
          </p>
        </div>
        <ConnectionBadge :state="state" kind="whatsapp" :lost="mode === 'lost'" />
      </div>
    </div>

    <!-- ── pairing ─────────────────────────────────────────────────────── -->
    <Card v-if="mode === 'pairing'">
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

    <!-- ── connected, or was ───────────────────────────────────────────── -->
    <template v-else>
      <!--
        A dropped session keeps its profile and counts below: the phone is still
        linked, and everything stored up to the drop is still readable.
      -->
      <div v-if="mode === 'lost'" class="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
        <div>
          <p class="text-sm font-medium">
            WhatsApp dropped this account's connection
          </p>
          <p v-if="canManage" class="mt-1 text-sm text-muted-foreground">
            New messages are not arriving and nothing can be sent until it
            reconnects. The phone is still linked, so reconnecting normally needs
            no new QR code.
          </p>
          <p v-else class="mt-1 text-sm text-muted-foreground">
            New messages are not arriving and nothing can be sent until it
            reconnects. An admin of your organization can bring it back.
          </p>
        </div>

        <p v-if="canManage && reconnectStalled" class="text-sm text-muted-foreground">
          Evolution did not bring the connection back. Its session for this account
          may be stuck — restarting {{ data?.instance.ownServer ? 'your Evolution server' : 'the Evolution server' }}
          usually reconnects it without a new scan.
        </p>

        <Button v-if="canManage" size="sm" :disabled="reconnectBusy || reconnecting" @click="reconnect">
          {{ reconnecting ? 'Reconnecting…' : reconnectStalled ? 'Try again' : 'Reconnect' }}
        </Button>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <!-- The profile sits in the same row as the counts, so it stretches to
             their height and centres its contents rather than riding the top. -->
        <Card>
          <CardContent class="flex flex-1 items-center gap-4 pt-6">
            <img
              v-if="data?.profilePicUrl"
              :src="data.profilePicUrl"
              alt=""
              class="size-12 shrink-0 rounded-full object-cover"
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
        kind="whatsapp"
        :total="data?.stats.chats ?? 0"
      />

      <!-- The last sentence points at a section a member does not have, and
           re-importing costs a QR scan on a real phone — so they are told what
           the counts mean, not how to change them. -->
      <p class="text-xs text-muted-foreground">
        WhatsApp hands over its history only at the moment a device is linked, so
        these counts are the import from pairing plus everything since.
        <template v-if="canManage">
          If an old conversation is missing, re-import it under Manage.
        </template>
        <template v-else>
          If an old conversation is missing, an admin of your organization can
          re-import it.
        </template>
      </p>
    </template>

    <Separator />

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

    <!--
      Always shown, including while disconnected. Hiding it would mean you
      cannot revoke a token for an account that is offline — which is exactly
      when you are most likely to want to.
    -->
    <McpTokens
      :instance-id="id"
      kind="whatsapp"
      :connected="connected"
      :can-manage="canManage"
    />

    <template v-if="canManage">
      <Separator />

      <!-- ── controls ──────────────────────────────────────────────────── -->
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

          <AssignConnectionDialog :id="id" kind="whatsapp" />

          <DeleteConnectionDialog :id="id" :label="data?.instance.label" kind="whatsapp" />
        </div>
      </section>
    </template>
  </div>
</template>
