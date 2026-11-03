<script setup lang="ts">
import { ShieldCheckIcon, TriangleAlertIcon } from '@lucide/vue'

/**
 * The OAuth consent page: an MCP client (Claude, Claude Code, the Inspector)
 * sends someone here to connect. They are signed in by the global middleware,
 * which brings them back after the password and second factor.
 *
 * They pick which of their connections the app gets — one sign-in, one
 * connector in the client, every picked connection's tools under its handle
 * (`orders_db__run-query`). What each may do starts at a sensible default and
 * can be narrowed, never widened past the ceiling: everything for an admin,
 * the connection's sign-in policy for a member. The server re-checks all of it.
 *
 * The client's name is its own choice at registration and is shown as that; the
 * host the browser will be sent back to is what is actually verifiable, so it
 * is shown as prominently.
 */
interface Option {
  connection: { id: string, label: string, kind: InstanceKind, handle: string }
  allowed: boolean
  ceiling: TokenScope
  ceilingIsOpen: boolean
  defaultScope: TokenScope
  disclaimer?: string
}

interface Context {
  errorRedirect?: string
  client: { name: string, redirectHost: string }
  user: { email: string }
  org: { name: string }
  isAdmin: boolean
  options: Option[]
  admins: string[]
}

interface Picked {
  scope: TokenScope
  disclaimer: string | null
}

/**
 * A deep copy of plain scope data. Not `structuredClone`: `picked` is a deep
 * ref, so its scopes are reactive proxies, which structuredClone refuses.
 */
function cloneScope(scope: TokenScope): TokenScope {
  return JSON.parse(JSON.stringify(toRaw(scope))) as TokenScope
}

const route = useRoute()
const params = computed(() => ({ ...route.query }) as Record<string, string>)

const { data, error } = await useFetch<Context>('/api/oauth/authorize/context', { query: params })

/** Picked connections by id, each with the access it will get. */
const picked = ref<Record<string, Picked>>({})
const busy = ref(false)
const failure = ref('')

const allowedOptions = computed(() => data.value?.options.filter(o => o.allowed) ?? [])
const blockedOptions = computed(() => data.value?.options.filter(o => !o.allowed) ?? [])

/** With exactly one connection to offer, it is the obvious choice: preselect it. */
watch(data, (context) => {
  const allowed = context?.options.filter(o => o.allowed) ?? []
  if (allowed.length === 1 && Object.keys(picked.value).length === 0) toggle(allowed[0]!, true)
}, { immediate: true })

/** A request that is wrong but redirectable goes straight back to the client with its error. */
onMounted(() => {
  if (data.value?.errorRedirect) window.location.assign(data.value.errorRedirect)
})

function toggle(option: Option, on: boolean) {
  const next = { ...picked.value }
  if (on) next[option.connection.id] = { scope: cloneScope(option.defaultScope), disclaimer: null }
  else delete next[option.connection.id]
  picked.value = next
}

const allPicked = computed(() =>
  allowedOptions.value.length > 0 && allowedOptions.value.every(o => picked.value[o.connection.id]),
)

/** "All current connections": a snapshot. Later connections need a new sign-in. */
function toggleAll(on: boolean) {
  if (!on) {
    picked.value = {}
    return
  }
  const next = { ...picked.value }
  for (const option of allowedOptions.value) {
    next[option.connection.id] ??= { scope: cloneScope(option.defaultScope), disclaimer: null }
  }
  picked.value = next
}

const pickedCount = computed(() => Object.keys(picked.value).length)

// ── customizing one connection ─────────────────────────────────────────────

const customizing = ref<Option | null>(null)
const draftScope = ref<TokenScope>(openScope())
const draftDisclaimer = ref<string | null>(null)

function customize(option: Option) {
  const current = picked.value[option.connection.id]
  draftScope.value = cloneScope(current?.scope ?? option.defaultScope)
  draftDisclaimer.value = current?.disclaimer ?? null
  customizing.value = option
}

/**
 * A member narrows actions only, from the tools the ceiling allows; chats,
 * folders and tables stay as the ceiling sets them. An admin has no ceiling and
 * gets the full editor the token dialog uses.
 */
const { data: ceilingTools } = useFetch<{ tools: McpToolInfo[] }>(
  () => customizing.value ? `/api/instances/${customizing.value.connection.id}/mcp-tools` : '',
  { immediate: false, watch: [customizing], lazy: true, key: 'consent-tools' },
)
const narrowableTools = computed(() => {
  const option = customizing.value
  if (!option) return []
  const tools = ceilingTools.value?.tools ?? []
  return option.ceiling.all_tools ? tools : tools.filter(t => option.ceiling.tool_names.includes(t.name))
})
const draftToolSet = computed(() => new Set(draftScope.value.all_tools
  ? narrowableTools.value.map(t => t.name)
  : draftScope.value.tool_names))

function toggleTool(name: string, on: boolean) {
  const set = new Set(draftToolSet.value)
  if (on) set.add(name)
  else set.delete(name)
  draftScope.value = { ...draftScope.value, all_tools: false, tool_names: [...set] }
}

function saveCustomization() {
  const option = customizing.value
  if (!option) return
  picked.value = {
    ...picked.value,
    [option.connection.id]: {
      scope: draftScope.value,
      disclaimer: option.ceilingIsOpen ? disclaimerToSubmit(draftScope.value, option.connection.kind, draftDisclaimer.value) : null,
    },
  }
  customizing.value = null
}

// ── decision ───────────────────────────────────────────────────────────────

async function decide(decision: 'approve' | 'deny') {
  failure.value = ''
  busy.value = true
  try {
    const selections = Object.entries(picked.value).map(([connection, choice]) => ({
      connection,
      scope: choice.scope,
      send_disclaimer: choice.disclaimer,
    }))
    const result = await $fetch<{ redirect: string }>('/api/oauth/authorize', {
      method: 'POST',
      body: { params: params.value, decision, selections: decision === 'approve' ? selections : [] },
    })
    // Leaving the app: the client's own redirect URI, already verified server-side.
    window.location.assign(result.redirect)
  }
  catch (err) {
    failure.value = apiErrorMessage(err, decision === 'approve' ? 'Could not approve' : 'Could not cancel')
    busy.value = false
  }
}

useHead({ title: 'Connect an app' })
</script>

<template>
  <div class="mx-auto max-w-xl py-10">
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
            with access to the connections you pick. Continue only if you started
            this from that app.
          </p>
        </div>

        <div v-if="data.options.length" class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <p class="font-medium">
              Choose connections
            </p>
            <label v-if="allowedOptions.length > 1" class="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox :model-value="allPicked" @update:model-value="value => toggleAll(value === true)" />
              All current connections
            </label>
          </div>

          <div
            v-for="option in allowedOptions"
            :key="option.connection.id"
            class="flex items-start gap-3 rounded-md border p-3"
            :class="picked[option.connection.id] ? 'border-primary' : ''"
          >
            <Checkbox
              :id="`pick-${option.connection.id}`"
              class="mt-0.5"
              :model-value="Boolean(picked[option.connection.id])"
              @update:model-value="value => toggle(option, value === true)"
            />
            <label :for="`pick-${option.connection.id}`" class="min-w-0 flex-1 cursor-pointer space-y-0.5">
              <span class="block font-medium">{{ option.connection.label }}</span>
              <span class="block text-muted-foreground">
                {{ describeKind(option.connection.kind) }} · tools appear as
                <code class="font-mono text-xs">{{ option.connection.handle }}__…</code>
              </span>
              <span class="block text-xs text-muted-foreground">
                {{ describeScope(picked[option.connection.id]?.scope ?? option.defaultScope, option.connection.kind) }}
                <template v-if="option.disclaimer"> · sends are signed “{{ option.disclaimer }}”</template>
              </span>
            </label>
            <Button
              v-if="picked[option.connection.id]"
              variant="ghost"
              size="sm"
              @click="customize(option)"
            >
              Customize
            </Button>
          </div>

          <div
            v-for="option in blockedOptions"
            :key="option.connection.id"
            class="flex items-start gap-3 rounded-md border border-dashed p-3 opacity-70"
          >
            <Checkbox class="mt-0.5" :model-value="false" disabled />
            <span class="min-w-0 space-y-0.5">
              <span class="block font-medium">{{ option.connection.label }}</span>
              <span class="block text-xs text-muted-foreground">
                Not enabled for sign-in. Ask an admin<template v-if="data.admins.length">
                  ({{ data.admins.join(', ') }})</template> to allow it on the connection's page.
              </span>
            </span>
          </div>

          <p class="text-xs text-muted-foreground">
            Connections you add later need a new sign-in.
            <template v-if="!data.isAdmin">
              The most each one can do is set by an admin; you can narrow it here.
            </template>
          </p>
        </div>

        <div v-else class="space-y-2">
          <p>You have no connections to share yet.</p>
          <p class="text-muted-foreground">
            <template v-if="data.isAdmin">
              Create one first, then connect again from the app.
            </template>
            <template v-else>
              Ask an admin<template v-if="data.admins.length">
                ({{ data.admins.join(', ') }})</template> to assign you a connection, then connect again from the app.
            </template>
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
        <Button :disabled="busy || pickedCount === 0" @click="decide('approve')">
          {{ busy ? 'Connecting…' : pickedCount > 1 ? `Approve ${pickedCount} connections` : 'Approve' }}
        </Button>
      </CardFooter>
    </Card>

    <Dialog :open="Boolean(customizing)" @update:open="value => { if (!value) customizing = null }">
      <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl" :class="customizing?.ceilingIsOpen ? 'md:max-w-5xl' : ''">
        <DialogHeader class="shrink-0">
          <DialogTitle>What “{{ data?.client.name }}” may do on {{ customizing?.connection.label }}</DialogTitle>
          <DialogDescription v-if="customizing && !customizing.ceilingIsOpen">
            An admin allows at most: {{ describeScope(customizing.ceiling, customizing.connection.kind) }}.
            Untick actions you do not want it to have.
          </DialogDescription>
        </DialogHeader>

        <div v-if="customizing" class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto text-sm">
          <TokenScopeFields
            v-if="customizing.ceilingIsOpen"
            v-model="draftScope"
            v-model:disclaimer="draftDisclaimer"
            :instance-id="customizing.connection.id"
            :kind="customizing.connection.kind"
          />
          <template v-else>
            <label
              v-for="tool in narrowableTools"
              :key="tool.name"
              class="flex cursor-pointer items-start gap-3 rounded-md border p-2"
            >
              <Checkbox
                class="mt-0.5"
                :model-value="draftToolSet.has(tool.name)"
                @update:model-value="value => toggleTool(tool.name, value === true)"
              />
              <span class="min-w-0">
                <span class="block font-medium">{{ tool.title }}</span>
                <span class="block text-xs text-muted-foreground">{{ tool.readOnly ? 'Read' : 'Write' }}</span>
              </span>
            </label>
          </template>
        </div>

        <DialogFooter class="shrink-0">
          <Button variant="ghost" @click="customizing = null">
            Cancel
          </Button>
          <Button :disabled="!draftScope.all_tools && draftScope.tool_names.length === 0" @click="saveCustomization">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
