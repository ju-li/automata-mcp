<script setup lang="ts">
import { ArrowLeftIcon, CheckIcon, MailIcon } from '@lucide/vue'
import { assertNever } from '#shared/connection'

/**
 * First-run setup, for the admin whose signup created the organization and no
 * one else (`onboarding` on the session; server/utils/onboarding.ts decides).
 * The middleware sends them here from the landing routes until they finish or
 * skip it.
 *
 *   1. pick a connector        ConnectionCreateForm's picker
 *   2. name + credentials      its form for the chosen kind
 *   3. scan (WhatsApp/Telegram) the kind's panel in `setup` mode
 *   4. first connector token   McpTokens, its create dialog opened from here
 *   5. update mail             self-hosted only: breaking changes and
 *                              security advisories, nothing else
 *
 * Every step is the ordinary route with its ordinary checks; this page only
 * orders them. Progress after the connection exists lives in the URL
 * (`?connection=&step=`), so the wizard's own navigation never creates a second
 * connection.
 *
 * **Starting is the last chance it gets.** Picking a connector clears the
 * server's flag (the same call as Skip), so someone who walks away mid-way —
 * closes the tab at the QR code — comes back to the ordinary screens, not to
 * step 1 again (where a plan at its connection limit could not even pick).
 * The run in progress carries on through `welcome:active`, which lasts for this
 * page load only; middleware/auth.global.ts reads it.
 */
type Step = 'pick' | 'details' | 'pair' | 'token' | 'updates'

const route = useRoute()
const { user, onboarding, refresh: refreshSession } = useSession()

const connectionId = computed(() => typeof route.query.connection === 'string' ? route.query.connection : undefined)
const kind = ref<InstanceKind | undefined>()

// Keyed on the id, so the step that adds `?connection=` fetches it, and no id
// asks nothing (a `useFetch` that starts not-immediate never wakes up).
// useRequestFetch carries the session cookie during SSR; bare $fetch would not.
const requestFetch = useRequestFetch()
const { data: summary, error: summaryError } = await useAsyncData(
  () => `welcome-summary-${connectionId.value ?? 'none'}`,
  () => connectionId.value
    ? requestFetch<{ instance: PublicInstanceRow, canManage: boolean }>(`/api/instances/${connectionId.value}/summary`)
    : Promise.resolve(null),
)
// A connection gone since (the unpaired reaper, or deleted elsewhere) restarts
// setup at the picker rather than showing an error.
handlesErrorItself(summaryError)
const connectionKind = computed(() => summaryError.value ? undefined : summary.value?.instance.kind)

/** Whether a kind is linked by scanning a code on a phone. */
function pairs(k: InstanceKind): boolean {
  switch (k) {
    case 'whatsapp':
    case 'telegram':
      return true
    case 'postgres':
    case 'imap':
      return false
    default:
      return assertNever(k, 'connection kind')
  }
}

// Read once: the flag is cleared as soon as a connector is picked, and the
// session refresh that follows must not take the last step away mid-run.
const offersUpdates = onboarding.value?.updates === true

/** Live for this page load once setup has started; see the header comment. */
const active = useState<boolean>('welcome:active', () => false)
const { run: runStart } = useApiAction()

/** Clear the organization's onboarding flag, and the session's copy of it. */
async function clearOnboarding() {
  await $fetch('/api/onboarding/finish', { method: 'POST' })
  await refreshSession()
  return true
}

/** Clear the flag the first time a connector is picked. Failure only means a later visit lands here again. */
async function start() {
  if (active.value) return
  active.value = true
  await runStart(clearOnboarding, { failure: 'Could not save setup progress' })
}
watch(kind, (picked) => { if (picked) void start() })

const step = computed<Step>(() => {
  const k = connectionKind.value
  if (!connectionId.value || !k) return kind.value ? 'details' : 'pick'
  const asked = route.query.step
  if (asked === 'updates' && offersUpdates) return 'updates'
  if (asked === 'token') return 'token'
  return pairs(k) ? 'pair' : 'token'
})

/** The steps this run has, in order: no scan for a database or mailbox, no updates on the hosted service. */
const steps = computed(() => {
  const k = connectionKind.value ?? kind.value
  return [
    { id: 'pick' as const, title: 'Pick a connector' },
    { id: 'details' as const, title: 'Name and credentials' },
    ...(!k || pairs(k) ? [{ id: 'pair' as const, title: 'Scan the QR code' }] : []),
    { id: 'token' as const, title: 'Create a token' },
    ...(offersUpdates ? [{ id: 'updates' as const, title: 'Stay informed' }] : []),
  ]
})
const currentIndex = computed(() => steps.value.findIndex(s => s.id === step.value))

/**
 * The step Back returns to, if any. Only steps after the connection exists:
 * back to the form would create a second connection, so the first of them
 * (scan, or token for a database or mailbox) has none.
 */
const previousStep = computed<Step | undefined>(() => {
  const before = steps.value[currentIndex.value - 1]?.id
  return before === 'pair' || before === 'token' ? before : undefined
})

function goTo(next: Step) {
  return navigateTo({ query: { connection: connectionId.value, step: next } })
}

async function created(instance: { id: string, kind: InstanceKind }) {
  await navigateTo({ query: { connection: instance.id, step: pairs(instance.kind) ? 'pair' : 'token' } })
}

// ── step 3 ────────────────────────────────────────────────────────────────
const paired = ref(false)

// ── step 4 ────────────────────────────────────────────────────────────────
const tokens = ref<{ openCreate: () => void } | null>(null)
const tokenCreated = ref(false)

function afterToken() {
  if (offersUpdates) return goTo('updates')
  return finish()
}

// ── step 5 ────────────────────────────────────────────────────────────────
const email = ref(user.value?.email ?? '')
const subscribed = ref(false)
/** Our list asks each address to confirm by email (double opt-in). */
const mustConfirm = ref(false)
const { busy: subscribing, run: runSubscribe } = useApiAction()

async function subscribe() {
  const ok = await runSubscribe(
    () => $fetch<{ ok: boolean, confirm?: boolean }>('/api/onboarding/updates', { method: 'POST', body: { email: email.value.trim() } }),
    { failure: 'Could not sign you up' },
  )
  if (!ok) return
  mustConfirm.value = ok.confirm === true
  subscribed.value = true
}

// ── finishing ─────────────────────────────────────────────────────────────
const { busy: finishing, run: runFinish } = useApiAction()

/** Finish or skip: either way setup is over, and the connection's page (or the list) is next. */
async function finish() {
  const done = await runFinish(clearOnboarding, { failure: 'Could not finish setup' })
  if (!done) return
  await navigateTo(connectionKind.value && connectionId.value ? `/instances/${connectionId.value}` : '/instances/new')
}
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-8">
    <!--
      One width for the page, so the header and stepper stay put between steps
      (and the stepper fits one row); the form-shaped steps narrow themselves.
    -->
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="font-heading text-2xl font-semibold">
          Welcome to Automata
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          A few steps to give Claude its first connection.
        </p>
      </div>
      <Button variant="ghost" size="sm" :disabled="finishing" @click="finish">
        Skip setup
      </Button>
    </div>

    <!--
      Brand colours, so where you are reads at a glance: done = lime with an ink
      check, current = ink with a lime numeral and a lime halo, ahead = outline.
      Lime alone on the cream ground is too faint to carry "current" by itself.
    -->
    <ol class="flex flex-wrap items-center gap-x-3 gap-y-3 text-sm">
      <li
        v-for="(s, index) in steps"
        :key="s.id"
        class="flex items-center gap-3"
        :aria-current="index === currentIndex ? 'step' : undefined"
      >
        <span
          v-if="index > 0"
          aria-hidden="true"
          class="hidden h-0.5 w-6 rounded-full sm:block"
          :class="index <= currentIndex ? 'bg-foreground' : 'bg-border'"
        />
        <span
          class="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors"
          :class="index < currentIndex
            ? 'bg-primary text-primary-foreground'
            : index === currentIndex
              ? 'bg-foreground text-primary ring-4 ring-primary/60'
              : 'border border-border bg-card text-muted-foreground'"
        >
          <CheckIcon v-if="index < currentIndex" class="size-4" stroke-width="3" />
          <template v-else>{{ index + 1 }}</template>
        </span>
        <span
          :class="index === currentIndex
            ? 'font-semibold text-foreground'
            : index < currentIndex ? 'text-foreground' : 'text-muted-foreground'"
        >
          {{ s.title }}
        </span>
      </li>
    </ol>

    <!-- ── 1–2: pick, then name and credentials ──────────────────────────── -->
    <section v-if="step === 'pick' || step === 'details'" class="space-y-4" :class="step === 'details' ? 'max-w-xl' : ''">
      <div>
        <h2 class="font-heading text-lg font-semibold">
          {{ step === 'pick' ? 'What should Claude connect to?' : 'Name it and add its credentials' }}
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ step === 'pick'
            ? 'Start with one. You can add more connections later, each with its own connector.'
            : 'Credentials are checked before anything is saved.' }}
        </p>
      </div>
      <ConnectionCreateForm v-model:kind="kind" hide-coming-soon @created="created" />
    </section>

    <!-- ── 3: scan ───────────────────────────────────────────────────────── -->
    <section v-else-if="step === 'pair' && connectionId" class="max-w-xl space-y-4">
      <div>
        <h2 class="font-heading text-lg font-semibold">
          Link your {{ connectionKind === 'telegram' ? 'Telegram account' : 'phone' }}
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Scan the code with {{ connectionKind === 'telegram' ? 'Telegram' : 'WhatsApp' }} on your phone.
          This page moves on once it is linked.
        </p>
      </div>

      <InstanceWhatsapp
        v-if="connectionKind === 'whatsapp'"
        :id="connectionId"
        can-manage
        setup
        @paired="paired = true"
      />
      <InstanceTelegram
        v-else-if="connectionKind === 'telegram'"
        :id="connectionId"
        can-manage
        setup
        @paired="paired = true"
      />

      <div class="flex justify-end">
        <Button :disabled="!paired" @click="goTo('token')">
          Continue
        </Button>
      </div>
    </section>

    <!-- ── 4: first token ────────────────────────────────────────────────── -->
    <section v-else-if="step === 'token' && connectionId && connectionKind" class="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Create your first connector token</CardTitle>
          <CardDescription>
            A token is what Claude signs in with. It reaches this connection and no
            other, you choose what it may do, and you can revoke it at any time.
            Once it is created, the next screen shows how to add it to Claude.
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-wrap gap-3">
          <Button v-if="previousStep" variant="outline" :disabled="finishing" @click="goTo(previousStep)">
            <ArrowLeftIcon />
            Back
          </Button>
          <Button v-if="!tokenCreated" @click="tokens?.openCreate()">
            Create token
          </Button>
          <Button v-else :disabled="finishing" @click="afterToken">
            {{ offersUpdates ? 'Continue' : 'Finish setup' }}
          </Button>
          <Button v-if="!tokenCreated" variant="ghost" :disabled="finishing" @click="afterToken">
            Skip for now
          </Button>
        </CardContent>
      </Card>

      <McpTokens
        ref="tokens"
        :instance-id="connectionId"
        :kind="connectionKind"
        :connected="true"
        can-manage
        @created="tokenCreated = true"
      />
    </section>

    <!-- ── 5: update mail (self-hosted only) ─────────────────────────────── -->
    <section v-else-if="step === 'updates'" class="max-w-xl space-y-4">
      <Card>
        <CardHeader>
          <div class="flex items-center gap-2">
            <MailIcon class="size-5 text-muted-foreground" />
            <CardTitle>Hear about breaking changes and security fixes</CardTitle>
          </div>
          <CardDescription>
            You run this install yourself, so nobody can tell you when an update
            needs your attention. Leave an address and we will email it when a
            release has breaking changes or fixes a security issue.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Only breaking changes and security advisories. A handful of emails a year.</li>
            <li>No marketing, no newsletters, no spam — and your address is never shared or sold.</li>
            <li>Every email has an unsubscribe link.</li>
          </ul>

          <template v-if="!subscribed">
            <div class="space-y-2">
              <Label for="updates-email">Email</Label>
              <Input
                id="updates-email"
                v-model="email"
                type="email"
                autocomplete="email"
                @keydown.enter="subscribe"
              />
              <p class="text-xs text-muted-foreground">
                Sent to Automata (getautomata.app) with this install's version,
                and used for these emails only.
              </p>
            </div>
            <div class="flex flex-wrap gap-3">
              <Button v-if="previousStep" variant="outline" :disabled="subscribing || finishing" @click="goTo(previousStep)">
                <ArrowLeftIcon />
                Back
              </Button>
              <Button :disabled="subscribing || !email.trim()" @click="subscribe">
                {{ subscribing ? 'Signing up…' : 'Sign me up' }}
              </Button>
              <Button variant="ghost" :disabled="finishing" @click="finish">
                No thanks
              </Button>
            </div>
          </template>

          <template v-else>
            <p v-if="mustConfirm" class="flex items-start gap-2 text-sm">
              <MailIcon class="mt-0.5 size-4 shrink-0" />
              <span>
                <span class="font-medium">Check your inbox to confirm.</span>
                We sent a link to {{ email.trim() }}. Nothing is sent to it until you click it.
              </span>
            </p>
            <p v-else class="flex items-center gap-2 text-sm">
              <CheckIcon class="size-4 text-primary" />
              You're on the list.
            </p>
            <Button :disabled="finishing" @click="finish">
              Finish setup
            </Button>
          </template>
        </CardContent>
      </Card>
    </section>
  </div>
</template>
