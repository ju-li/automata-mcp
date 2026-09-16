<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { ArrowLeftIcon, MessageSquareTextIcon, MessagesSquareIcon, SendIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * The link-and-dashboard panel for a Telegram connection. Chosen by
 * pages/instances/[id].vue from the connection's kind.
 *
 * Unlike WhatsApp, a Telegram connection is created unlinked and pairing is a
 * separate, explicit step: the account is linked by an admin pressing a button,
 * never by opening the page, because it binds a real Telegram account.
 */
const props = withDefaults(defineProps<{
  id: string
  /**
   * Whether this viewer may change the connection, as opposed to use it.
   * Decided by the server; presentation only — every control it hides is
   * independently refused with a 403.
   */
  canManage?: boolean
}>(), { canManage: false })

interface StatusResponse {
  instance: PublicInstanceRow
  state: ConnectionState
  /** Linked, and the connection to Telegram dropped. */
  sessionLost?: boolean
  /** Telegram ended the session; only linking again brings it back. */
  revoked?: boolean
  pairing?: 'qr' | 'password'
  telegramUserId?: string
  profileName?: string
  username?: string
  number?: string
  error?: string
  stats?: { messages: number, chats: number }
  sync?: { backfilling: boolean, pendingBackfill: number, dialogsSyncedAt?: string, pausedUntil?: string }
}

interface PairingView {
  state: ConnectionState
  pairing?: 'qr' | 'password'
  passwordHint?: string
  passwordRejected?: boolean
  revoked?: boolean
  error?: string
  qr?: { dataUrl: string, expiresAt: string }
}

const id = computed(() => props.id)

const { data, refresh } = await useFetch<StatusResponse>(() => `/api/instances/${id.value}`)

const state = computed<ConnectionState>(() => data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')
/** A Telegram account is (or was until it dropped) linked to this connection. */
const linked = computed(() => Boolean(data.value?.telegramUserId) || data.value?.sessionLost === true)

/** The live pairing flow, as last reported by the bridge. */
const pairing = ref<PairingView | null>(null)
const pairingError = ref('')
const password = ref('')

type Mode = 'connected' | 'pairing' | 'lost' | 'unreachable' | 'unlinked'

/**
 * **Only a manager enters pairing mode**, for the reason InstanceWhatsapp gives:
 * linking binds a real account, and someone who cannot press the button has no
 * business being shown a QR code. A member sees what the state is and who can
 * change it.
 */
const mode = computed<Mode>(() => {
  if (connected.value) return 'connected'
  if (props.canManage && (pairing.value?.pairing || data.value?.pairing)) return 'pairing'
  if (data.value?.sessionLost) return 'lost'
  if (state.value === 'unknown') return 'unreachable'
  return 'unlinked'
})

const display = computed(() => describeState(state.value, 'telegram', { lost: mode.value === 'lost' }))

const needsDbUrl = computed(() =>
  data.value?.instance.ownServer === true && data.value?.instance.canReadMessages === false,
)
const dbUrl = ref('')
const chatsOpen = ref(false)
const messagesOpen = ref(false)

const { busy, run } = useApiAction()
const { busy: passwordBusy, run: runPassword } = useApiAction()
const { busy: savingDbUrl, run: runSaveDbUrl } = useApiAction()
const { busy: reconnectBusy, run: runReconnect } = useApiAction()

// ── pairing ────────────────────────────────────────────────────────────────
/**
 * Polling the QR endpoint is safe here, which is not true of WhatsApp: the
 * bridge only reads the code of a flow `pair` already started and never asks
 * Telegram for a login token on its own. The code rotates about every 30
 * seconds, and the poll is what picks up the next one.
 */
const { pause: pauseQrPoll, resume: resumeQrPoll } = useIntervalFn(async () => {
  if (mode.value !== 'pairing') return
  try {
    applyPairing(await $fetch<PairingView>(`/api/instances/${id.value}/telegram/qr`))
  }
  catch {
    // Transient. The next tick retries.
  }
}, 2000, { immediate: false })

async function applyPairing(view: PairingView) {
  if (view.pairing) {
    // Keep the last image while the bridge generates the next code, so the QR
    // does not flicker between polls.
    pairing.value = { ...view, qr: view.qr ?? (view.pairing === 'qr' ? pairing.value?.qr : undefined) }
    return
  }

  // The flow has ended: linked, or given up.
  pairing.value = null
  password.value = ''
  if (view.state !== 'open') {
    pairingError.value = view.error ?? 'Linking did not complete. Start again to get a new QR code.'
  }
  await refresh()
  if (view.state === 'open') toast.success('Telegram account linked.')
}

async function startPairing() {
  pairingError.value = ''
  await run(
    async () => {
      const view = await $fetch<PairingView>(`/api/instances/${id.value}/telegram/pair`, { method: 'POST' })
      pairing.value = { ...view, pairing: view.pairing ?? 'qr' }
    },
    { failure: 'Could not start linking' },
  )
}

/**
 * The password leaves the input the moment it is sent, and is not kept anywhere
 * on the page. A wrong one comes back as `passwordRejected` on the next poll.
 */
async function submitPassword() {
  const value = password.value
  if (!value) return
  password.value = ''
  await runPassword(
    async () => {
      applyPairing(await $fetch<PairingView>(`/api/instances/${id.value}/telegram/password`, {
        method: 'POST',
        body: { password: value },
      }))
    },
    { failure: 'Could not submit the password' },
  )
}

// ── status ─────────────────────────────────────────────────────────────────
const { pause: pauseStatusPoll, resume: resumeStatusPoll } = useIntervalFn(() => refresh(), 15000, { immediate: false })

// ── reconnecting ───────────────────────────────────────────────────────────
const RECONNECT_WATCH_MS = 60_000
const reconnecting = ref(false)
const reconnectStalled = ref(false)
const reconnectStartedAt = ref(0)

const { pause: pauseReconnectPoll, resume: resumeReconnectPoll } = useIntervalFn(async () => {
  await refresh()
  if (mode.value !== 'lost') {
    pauseReconnectPoll()
    reconnecting.value = false
    return
  }
  if (Date.now() - reconnectStartedAt.value > RECONNECT_WATCH_MS) {
    pauseReconnectPoll()
    reconnecting.value = false
    reconnectStalled.value = true
  }
}, 3000, { immediate: false })

async function reconnect() {
  reconnectStalled.value = false
  const asked = await runReconnect(
    async () => {
      await $fetch(`/api/instances/${id.value}/telegram/reconnect`, { method: 'POST' })
      return true
    },
    { failure: 'Could not reconnect this account' },
  )
  if (!asked) return
  reconnecting.value = true
  reconnectStartedAt.value = Date.now()
  resumeReconnectPoll()
}

// ── polling follows the mode ───────────────────────────────────────────────
function applyMode(next: Mode) {
  if (next === 'pairing') {
    pauseStatusPoll()
    resumeQrPoll()
  }
  else {
    pauseQrPoll()
    resumeStatusPoll()
  }
}

watch(mode, (next, previous) => {
  if (previous === 'lost' && next === 'connected' && reconnecting.value) toast.success('Reconnected.')
  applyMode(next)
})

onMounted(() => applyMode(mode.value))

// ── actions ────────────────────────────────────────────────────────────────
async function unlink() {
  await run(
    async () => {
      await $fetch(`/api/instances/${id.value}/telegram/logout`, { method: 'POST' })
      pairing.value = null
      pairingError.value = ''
      await refresh()
    },
    {
      success: 'Unlinked. The chats synced for this account were deleted.',
      failure: 'Could not unlink this account',
      preferServerMessage: false,
    },
  )
}

async function saveDbUrl() {
  if (!dbUrl.value.trim()) return
  await runSaveDbUrl(
    async () => {
      await $fetch(`/api/instances/${id.value}/telegram-db`, { method: 'PATCH', body: { dbUrl: dbUrl.value.trim() } })
      dbUrl.value = ''
      await refresh()
    },
    {
      success: 'Claude can now read and search this account\'s chats.',
      failure: 'Could not save the database connection string',
    },
  )
}

const count = new Intl.NumberFormat()
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
            {{ canManage ? display.hint : `Telegram account · ${display.label.toLowerCase()}` }}
          </p>
        </div>
        <ConnectionBadge :state="state" kind="telegram" :lost="mode === 'lost'" />
      </div>
    </div>

    <!-- ── not linked ──────────────────────────────────────────────────── -->
    <Card v-if="mode === 'unlinked'">
      <CardHeader>
        <CardTitle>{{ data?.revoked ? 'Telegram ended this session' : 'Link a Telegram account' }}</CardTitle>
        <CardDescription v-if="canManage">
          <template v-if="data?.revoked">
            Someone terminated this device from Telegram → Settings → Devices, or the
            account was deleted. Link it again to resume; chats synced so far are kept.
          </template>
          <template v-else>
            You will scan a QR code with Telegram on your phone. Chats then sync into
            this connection and Claude can read and send through it.
          </template>
        </CardDescription>
        <CardDescription v-else>
          This connection is not linked to a Telegram account right now. An admin of
          your organization can link it.
        </CardDescription>
      </CardHeader>
      <CardContent v-if="canManage" class="space-y-4">
        <p v-if="pairingError" class="text-sm text-destructive">
          {{ pairingError }}
        </p>
        <Button :disabled="busy" @click="startPairing">
          <SendIcon class="size-4" />
          {{ busy ? 'Starting…' : 'Show QR code' }}
        </Button>
        <p class="text-xs text-muted-foreground">
          This app signs in as an unofficial Telegram client, which Telegram watches
          more closely than its own apps, and its API terms restrict using chats for
          AI. Use an account you are comfortable linking this way.
        </p>
      </CardContent>
    </Card>

    <!-- ── pairing ─────────────────────────────────────────────────────── -->
    <Card v-else-if="mode === 'pairing'">
      <template v-if="(pairing?.pairing ?? data?.pairing) === 'password'">
        <CardHeader>
          <CardTitle>Enter your two-step verification password</CardTitle>
          <CardDescription>
            This Telegram account has a password on top of the QR code. It goes
            straight to Telegram and is not stored.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 pb-8">
          <div class="space-y-2">
            <Label for="tg-password">Password</Label>
            <Input
              id="tg-password"
              v-model="password"
              type="password"
              autocomplete="off"
              @keydown.enter="submitPassword"
            />
            <p v-if="pairing?.passwordHint" class="text-xs text-muted-foreground">
              Hint: {{ pairing.passwordHint }}
            </p>
            <p v-if="pairing?.passwordRejected" class="text-xs text-destructive">
              That password was not right. Try again.
            </p>
          </div>
          <Button :disabled="passwordBusy || !password" @click="submitPassword">
            {{ passwordBusy ? 'Checking…' : 'Continue' }}
          </Button>
        </CardContent>
      </template>

      <template v-else>
        <CardHeader>
          <CardTitle>Scan to link</CardTitle>
          <CardDescription>
            In Telegram on your phone: Settings → Devices → Link Desktop Device, then
            point the camera at this code.
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col items-center gap-4 pb-8">
          <div class="flex size-64 items-center justify-center rounded-lg border bg-white p-2">
            <img v-if="pairing?.qr?.dataUrl" :src="pairing.qr.dataUrl" alt="Telegram login QR code" class="size-full">
            <Skeleton v-else class="size-full" />
          </div>
          <p class="text-center text-xs text-muted-foreground">
            The code refreshes on its own. If nobody scans it within five minutes,
            start again.
          </p>
        </CardContent>
      </template>
    </Card>

    <!-- ── linked, or was ──────────────────────────────────────────────── -->
    <template v-else>
      <div v-if="mode === 'lost'" class="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
        <div>
          <p class="text-sm font-medium">
            Telegram dropped this account's connection
          </p>
          <p class="mt-1 text-sm text-muted-foreground">
            New messages are not arriving and nothing can be sent until it reconnects.
            <template v-if="canManage">
              The account is still linked, so reconnecting needs no QR code.
            </template>
            <template v-else>
              An admin of your organization can bring it back.
            </template>
          </p>
        </div>
        <p v-if="canManage && reconnectStalled" class="text-sm text-muted-foreground">
          The connection did not come back. {{ data?.error ? `Telegram said: ${data.error}.` : '' }}
          Try again in a minute, or restart the Telegram bridge.
        </p>
        <Button v-if="canManage" size="sm" :disabled="reconnectBusy || reconnecting" @click="reconnect">
          {{ reconnecting ? 'Reconnecting…' : reconnectStalled ? 'Try again' : 'Reconnect' }}
        </Button>
      </div>

      <div v-if="mode === 'unreachable'" class="rounded-md border border-destructive/40 bg-destructive/5 p-4">
        <p class="text-sm font-medium">
          Could not reach the Telegram bridge
        </p>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ data?.error || 'The service that keeps this account connected did not answer.' }}
          Synced chats stay readable; linking, reconnecting and sending wait for it.
        </p>
      </div>

      <Card v-if="linked">
        <CardContent class="flex items-center gap-4 pt-6">
          <span class="flex size-12 items-center justify-center rounded-full bg-muted">
            <SendIcon class="size-5 text-muted-foreground" />
          </span>
          <div class="min-w-0">
            <p class="truncate font-medium">
              {{ data?.profileName || 'Telegram' }}
            </p>
            <p class="truncate text-sm text-muted-foreground tabular-nums">
              <template v-if="data?.username">@{{ data.username }}</template>
              <template v-if="data?.username && data?.number"> · </template>
              <template v-if="data?.number">+{{ data.number }}</template>
              <template v-if="!data?.username && !data?.number">—</template>
            </p>
          </div>
        </CardContent>
      </Card>

      <div class="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Messages"
          :value="data?.stats?.messages ?? 0"
          :icon="MessageSquareTextIcon"
          :clickable="data?.instance.canReadMessages !== false"
          @click="messagesOpen = true"
        />
        <StatCard
          label="Chats"
          :value="data?.stats?.chats ?? 0"
          :icon="MessagesSquareIcon"
          clickable
          @click="chatsOpen = true"
        />
      </div>

      <ChatsDialog
        v-model:open="chatsOpen"
        :instance-id="id"
        kind="telegram"
        :total="data?.stats?.chats ?? 0"
      />

      <MessagesDialog
        v-model:open="messagesOpen"
        :instance-id="id"
        kind="telegram"
        :total="data?.stats?.messages ?? 0"
      />

      <p class="text-xs text-muted-foreground">
        <template v-if="data?.sync && data.sync.pendingBackfill > 0">
          Fetching older history: {{ count.format(data.sync.pendingBackfill) }}
          {{ data.sync.pendingBackfill === 1 ? 'chat' : 'chats' }} to go<template v-if="data.sync.pausedUntil">,
            paused by Telegram until {{ new Date(data.sync.pausedUntil).toLocaleTimeString() }}</template>.
          New messages sync as they arrive.
        </template>
        <template v-else>
          New messages sync as they arrive. Older history is fetched within this
          connection's limits, and Claude is told when a chat's history is incomplete.
        </template>
      </p>
    </template>

    <Separator />

    <div v-if="needsDbUrl" class="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div>
        <p class="text-sm font-medium">
          Claude cannot read this account's chats yet
        </p>
        <p class="mt-1 text-sm text-muted-foreground">
          Reading and searching go to your Telegram bridge's database. This app has the
          bridge's URL but not its database. Linking and sending already work.
        </p>
      </div>
      <div class="space-y-2">
        <Label for="tg-db-url">Database connection string</Label>
        <Input
          id="tg-db-url"
          v-model="dbUrl"
          autocomplete="off"
          spellcheck="false"
          placeholder="postgresql://user:password@host:5432/database"
          @keydown.enter="saveDbUrl"
        />
        <p class="text-xs text-muted-foreground">
          Checked against the bridge's <span class="font-mono">telegram</span> schema before it is saved.
        </p>
      </div>
      <Button size="sm" :disabled="savingDbUrl || !dbUrl.trim()" @click="saveDbUrl">
        {{ savingDbUrl ? 'Checking…' : 'Enable reading' }}
      </Button>
    </div>

    <!-- Always shown, including while unlinked: a token must be revocable
         exactly when the account is not working. -->
    <McpTokens
      :instance-id="id"
      kind="telegram"
      :connected="connected"
      :can-manage="canManage"
    />

    <template v-if="canManage">
      <Separator />

      <section class="space-y-4">
        <h2 class="font-heading text-lg font-semibold">
          Manage
        </h2>

        <div class="flex flex-wrap gap-3">
          <AlertDialog v-if="linked">
            <AlertDialogTrigger as-child>
              <Button variant="outline" :disabled="busy">
                Unlink account
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unlink this Telegram account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This signs the connection out of Telegram and deletes every chat synced
                  for it. Connector tokens are kept, but read and send nothing until an
                  account is linked again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="unlink">
                  Unlink
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AssignConnectionDialog :id="id" kind="telegram" />

          <DeleteConnectionDialog :id="id" :label="data?.instance.label" kind="telegram" />
        </div>
      </section>
    </template>
  </div>
</template>
