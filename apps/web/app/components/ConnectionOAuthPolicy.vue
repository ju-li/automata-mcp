<script setup lang="ts">
import { LogInIcon, PencilIcon } from '@lucide/vue'

/**
 * "Sign in from Claude" for one connection: its tool prefix (handle) and, for
 * members, the most a sign-in may grant it.
 *
 * Signing in is not configured per token: anyone who reaches the connection
 * adds `/mcp` in their client, signs in, and picks connections there (see
 * pages/oauth/authorize.vue). An admin may grant anything; a member up to the
 * ceiling set here, which applies to their existing sign-ins from the next
 * request — narrowing it here takes effect at once, nothing to re-issue.
 *
 * Presentation only: the server enforces the ceiling and who may change it.
 */
const props = defineProps<{ instanceId: string, kind: InstanceKind, canManage: boolean }>()

interface Policy {
  oauthAvailable: boolean
  handle: string
  membersAllowed: boolean
  scope: TokenScope
  send_disclaimer?: string
}

const { data, refresh } = await useFetch<Policy>(() => `/api/instances/${props.instanceId}/oauth-policy`)
const { bearerUrl } = useConnectorUrl()

const editing = ref(false)
const draftAllowed = ref(false)
const draftScope = ref<TokenScope>(openScope())
const draftDisclaimer = ref<string | null>(null)
const { busy: saving, run: runSave } = useApiAction()

function startEdit() {
  if (!data.value) return
  draftAllowed.value = data.value.membersAllowed
  draftScope.value = structuredClone(data.value.scope)
  draftDisclaimer.value = data.value.send_disclaimer ?? null
  editing.value = true
}

async function save() {
  await runSave(async () => {
    await $fetch(`/api/instances/${props.instanceId}/oauth-policy`, {
      method: 'PUT',
      body: {
        membersAllowed: draftAllowed.value,
        ...draftScope.value,
        send_disclaimer: disclaimerToSubmit(draftScope.value, props.kind, draftDisclaimer.value),
      },
    })
    editing.value = false
    await refresh()
  }, { success: 'Saved. It applies to members’ sign-ins from their next request.', failure: 'Could not save' })
}

const renaming = ref(false)
const draftHandle = ref('')
const { busy: renamingBusy, run: runRename } = useApiAction()

function startRename() {
  draftHandle.value = data.value?.handle ?? ''
  renaming.value = true
}

async function rename() {
  await runRename(async () => {
    await $fetch(`/api/instances/${props.instanceId}/handle`, { method: 'PATCH', body: { handle: draftHandle.value } })
    renaming.value = false
    await refresh()
  }, { success: 'Tool prefix changed', failure: 'Could not change the tool prefix' })
}

const howTo = ref(false)

/**
 * The viewer's own sign-ins that do not include this connection yet, so it
 * can be added to one without the app going through authorization again.
 * Fetched lazily: most dashboard visits never need it.
 */
interface OwnSession {
  id: string
  client: { name: string }
  connections: { id: string }[]
}
const { data: sessions, refresh: refreshSessions } = useFetch<{ sessions: OwnSession[] }>('/api/oauth/sessions', {
  lazy: true,
  server: false,
  default: () => ({ sessions: [] }),
})
const addable = computed(() =>
  (sessions.value?.sessions ?? []).filter(s => !s.connections.some(c => c.id === props.instanceId)),
)
const { run: runAdd } = useApiAction()
const adding = ref<string | null>(null)

async function addTo(session: OwnSession) {
  adding.value = session.id
  await runAdd(async () => {
    await $fetch(`/api/oauth/sessions/${session.id}/connections`, {
      method: 'POST',
      body: { connection: props.instanceId },
    })
    await refreshSessions()
  }, {
    success: `Added. ${session.client.name} sees its tools the next time it reloads them.`,
    failure: 'Could not add it',
  })
  adding.value = null
}
</script>

<template>
  <Card v-if="data?.oauthAvailable">
    <CardContent class="space-y-3 p-4 text-sm">
      <div class="flex items-start justify-between gap-4">
        <div class="flex items-start gap-2">
          <LogInIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div class="space-y-1">
            <p class="font-medium">
              Sign in from Claude
            </p>
            <p class="text-muted-foreground">
              Add <code class="font-mono text-xs">{{ bearerUrl }}</code> in Claude, sign in, and pick
              this connection — no token to copy. Its tools appear as
              <code class="font-mono text-xs">{{ data.handle }}__…</code>
              <Button
                v-if="canManage"
                variant="ghost"
                size="icon"
                class="size-6 align-middle"
                aria-label="Change tool prefix"
                @click="startRename"
              >
                <PencilIcon class="size-3" />
              </Button>
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" @click="howTo = true">
          How to
        </Button>
      </div>

      <!-- A member can add it only where the ceiling allows them to sign it in at all. -->
      <div v-if="addable.length && (canManage || data.membersAllowed)" class="flex flex-wrap items-center gap-2 border-t pt-3">
        <span class="text-muted-foreground">Already signed in from an app? Add this connection to:</span>
        <Button
          v-for="session in addable"
          :key="session.id"
          variant="outline"
          size="sm"
          :disabled="adding === session.id"
          @click="addTo(session)"
        >
          {{ session.client.name }} ({{ session.connections.length }} connection{{ session.connections.length === 1 ? '' : 's' }})
        </Button>
      </div>

      <div class="flex items-center justify-between gap-4 border-t pt-3">
        <p v-if="canManage" class="text-muted-foreground">
          Admins can grant anything.
          <template v-if="data.membersAllowed">
            Members can grant up to: <span class="text-foreground">{{ describeScope(data.scope, kind) }}</span>.
          </template>
          <template v-else>
            Members assigned to it cannot sign it in yet.
          </template>
        </p>
        <p v-else class="text-muted-foreground">
          <template v-if="data.membersAllowed">
            You can grant up to: <span class="text-foreground">{{ describeScope(data.scope, kind) }}</span>.
          </template>
          <template v-else>
            Not enabled for members yet — an admin can allow it here.
          </template>
        </p>
        <Button v-if="canManage" variant="ghost" size="sm" @click="startEdit">
          Members…
        </Button>
      </div>
    </CardContent>

    <Dialog v-model:open="editing">
      <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-5xl">
        <DialogHeader class="shrink-0">
          <DialogTitle>What members may grant by signing in</DialogTitle>
          <DialogDescription>
            Applies to every member this connection is assigned to, including
            sign-ins they already made — narrowing it takes effect on their next
            request. Admins are not limited by it.
          </DialogDescription>
        </DialogHeader>
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <label class="flex shrink-0 cursor-pointer items-start gap-2 text-sm">
            <Checkbox :model-value="draftAllowed" class="mt-0.5" @update:model-value="value => draftAllowed = value === true" />
            <span>
              <span class="font-medium">Members can sign this connection in</span>
              <span class="block text-xs text-muted-foreground">Off: it is not offered to them when they connect an app.</span>
            </span>
          </label>
          <template v-if="draftAllowed">
            <Separator class="shrink-0" />
            <TokenScopeFields
              v-model="draftScope"
              v-model:disclaimer="draftDisclaimer"
              :instance-id="instanceId"
              :kind="kind"
            />
          </template>
        </div>
        <DialogFooter class="shrink-0">
          <Button variant="ghost" @click="editing = false">
            Cancel
          </Button>
          <Button :disabled="saving" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="renaming">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tool prefix</DialogTitle>
          <DialogDescription>
            Every app signed in to this connection lists its tools under this
            prefix. Changing it renames them there, which resets any per-tool
            permissions set in that app.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-2">
          <Label for="handle">Prefix</Label>
          <Input id="handle" v-model="draftHandle" class="font-mono" maxlength="20" />
          <p class="text-xs text-muted-foreground">
            1–20 lowercase letters, digits or underscores, starting with a letter. Unique in your organization.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="renaming = false">
            Cancel
          </Button>
          <Button :disabled="renamingBusy || !draftHandle" @click="rename">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <OAuthConnectDialog
      :open="howTo"
      :kind="kind"
      @update:open="value => howTo = value"
    />
  </Card>
</template>
