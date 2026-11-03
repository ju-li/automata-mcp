<script setup lang="ts">
import { ShieldCheckIcon, TriangleAlertIcon } from '@lucide/vue'

/**
 * The OAuth consent page: an MCP client (Claude, Claude Code, the Inspector)
 * sends someone here to connect. They are signed in by the global middleware,
 * which brings them back after the password and second factor.
 *
 * They choose one of their **own** connectors, as an admin created it — nothing
 * here edits scope, so a member cannot widen anything by approving. An admin
 * with nothing waiting may create one for themselves, through the same mint
 * path the dashboard uses.
 *
 * The client's name is its own choice at registration and is shown as that; the
 * host the browser will be sent back to is what is actually verifiable, so it
 * is shown as prominently.
 */
interface Grant {
  id: string
  label: string
  created?: string
  expiresAt?: string
  claimedBy?: string
  connection: { id: string, label: string, kind: InstanceKind }
  scope: TokenScope
}

interface Context {
  errorRedirect?: string
  client: { name: string, redirectHost: string }
  user: { email: string }
  org: { name: string }
  isAdmin: boolean
  grants: Grant[]
  connections: { id: string, label: string, kind: InstanceKind }[]
  admins: string[]
}

const route = useRoute()
const params = computed(() => ({ ...route.query }) as Record<string, string>)

const { data, error, refresh } = await useFetch<Context>('/api/oauth/authorize/context', {
  query: params,
})

const selected = ref<string>('')
const newConnection = ref<string>('')
const busy = ref(false)
const failure = ref('')

/** Preselect when there is exactly one obvious choice: the only grant waiting for sign-in. */
watch(data, (context) => {
  if (!context?.grants?.length) return
  if (context.grants.some(g => g.id === selected.value)) return
  const waiting = context.grants.filter(g => !g.claimedBy)
  selected.value = (waiting.length === 1 ? waiting[0] : context.grants.length === 1 ? context.grants[0] : undefined)?.id ?? ''
}, { immediate: true })

watch(data, (context) => {
  if (!newConnection.value && context?.connections?.length) newConnection.value = context.connections[0]!.id
}, { immediate: true })

/** A request that is wrong but redirectable goes straight back to the client with its error. */
onMounted(() => {
  if (data.value?.errorRedirect) window.location.assign(data.value.errorRedirect)
})

const selectedGrant = computed(() => data.value?.grants.find(g => g.id === selected.value))

async function decide(decision: 'approve' | 'deny') {
  failure.value = ''
  busy.value = true
  try {
    const result = await $fetch<{ redirect: string }>('/api/oauth/authorize', {
      method: 'POST',
      body: { params: params.value, decision, grant: decision === 'approve' ? selected.value : undefined },
    })
    // Leaving the app: the client's own redirect URI, already verified server-side.
    window.location.assign(result.redirect)
  }
  catch (err) {
    failure.value = apiErrorMessage(err, decision === 'approve' ? 'Could not approve' : 'Could not cancel')
    busy.value = false
    if (decision === 'approve') await refresh()
  }
}

async function createGrant() {
  if (!newConnection.value) return
  failure.value = ''
  busy.value = true
  try {
    const result = await $fetch<{ id: string }>('/api/oauth/authorize/grant', {
      method: 'POST',
      body: { connection: newConnection.value, label: data.value?.client.name.slice(0, 100) },
    })
    await refresh()
    selected.value = result.id
  }
  catch (err) {
    failure.value = apiErrorMessage(err, 'Could not create the connector')
  }
  finally {
    busy.value = false
  }
}

useHead({ title: 'Connect an app' })
</script>

<template>
  <div class="mx-auto max-w-lg py-10">
    <Card v-if="error">
      <CardHeader>
        <div class="mb-2 flex size-10 items-center justify-center rounded-md bg-muted">
          <TriangleAlertIcon class="size-5 text-muted-foreground" />
        </div>
        <CardTitle>This sign-in link does not work</CardTitle>
        <CardDescription>
          {{ apiErrorMessage(error, 'Start again from the app you were connecting.') }}
        </CardDescription>
      </CardHeader>
    </Card>

    <Card v-else-if="data?.errorRedirect">
      <CardHeader>
        <CardTitle>Returning to the app…</CardTitle>
      </CardHeader>
    </Card>

    <Card v-else-if="data">
      <CardHeader>
        <div class="mb-2 flex size-10 items-center justify-center rounded-md bg-muted">
          <ShieldCheckIcon class="size-5 text-muted-foreground" />
        </div>
        <CardTitle>Connect “{{ data.client.name }}”</CardTitle>
        <CardDescription>
          Signed in as {{ data.user.email }} · {{ data.org.name }}
        </CardDescription>
      </CardHeader>

      <CardContent class="space-y-5 text-sm">
        <div class="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
          <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            The name above is chosen by the app itself. Approving sends you back to
            <strong class="font-semibold break-all">{{ data.client.redirectHost }}</strong>
            with access to the connector you choose. Continue only if you started
            this from that app.
          </p>
        </div>

        <div v-if="data.grants.length" class="space-y-2">
          <p class="font-medium">
            Choose a connector
          </p>
          <RadioGroup v-model="selected" class="gap-2">
            <label
              v-for="grant in data.grants"
              :key="grant.id"
              class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem :value="grant.id" class="mt-0.5" />
              <span class="min-w-0 space-y-0.5">
                <span class="block font-medium">{{ grant.label }}</span>
                <span class="block text-muted-foreground">
                  {{ grant.connection.label }} · {{ describeKind(grant.connection.kind) }}
                </span>
                <span class="block text-xs text-muted-foreground">
                  {{ describeScope(grant.scope, grant.connection.kind) }}
                </span>
                <span v-if="grant.claimedBy" class="block text-xs text-muted-foreground">
                  Currently signed in via {{ grant.claimedBy }}. Approving moves it here and signs that one out.
                </span>
              </span>
            </label>
          </RadioGroup>
          <p class="text-xs text-muted-foreground">
            What a connector can reach is set on its connection's page<template v-if="!data.isAdmin">
              by an admin</template>.
          </p>
        </div>

        <div v-else-if="data.isAdmin" class="space-y-3">
          <p>
            You have no connector waiting for sign-in. Create one for yourself on
            one of your connections:
          </p>
          <p v-if="!data.connections.length" class="text-muted-foreground">
            Your organization has no connections yet. Create one first, then
            connect again from the app.
          </p>
          <div v-else class="flex gap-2">
            <Select v-model="newConnection">
              <SelectTrigger class="min-w-0 flex-1">
                <SelectValue placeholder="Choose a connection" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in data.connections" :key="connection.id" :value="connection.id">
                  {{ connection.label }} · {{ describeKind(connection.kind) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" :disabled="busy || !newConnection" @click="createGrant">
              Create connector
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            It starts with the default access a new token gets — read-only for a
            database or mailbox — and expires in 90 days. Change either on the
            connection's page.
          </p>
        </div>

        <div v-else class="space-y-2">
          <p>
            There is no connector waiting for you to sign in to.
          </p>
          <p class="text-muted-foreground">
            Ask an admin<template v-if="data.admins.length">
              ({{ data.admins.join(', ') }})</template>
            to create one for you with “Sign in from Claude”, then connect again from the app.
          </p>
        </div>

        <p v-if="failure" class="text-destructive">
          {{ failure }}
        </p>
      </CardContent>

      <CardFooter class="flex justify-end gap-2">
        <Button variant="ghost" :disabled="busy" @click="decide('deny')">
          Cancel
        </Button>
        <Button :disabled="busy || !selectedGrant" @click="decide('approve')">
          {{ busy ? 'Connecting…' : 'Approve' }}
        </Button>
      </CardFooter>
    </Card>
  </div>
</template>
