<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'

const props = defineProps<{
  instanceId: string
  kind: InstanceKind
  connected?: boolean
}>()

/**
 * A new token's starting scope depends on the kind.
 *
 * A WhatsApp token starts open, as it always has. A Postgres token starts
 * read-only — every read tool, no write tool — because the two mistakes do not
 * cost the same: a token that turns out to need writes is one edit away, and one
 * that turns out not to have needed them may already have made some.
 *
 * The read tools come from the server, since only it knows which exist.
 */
// Only a Postgres token needs this, and only to seed its default scope — a
// WhatsApp dashboard was fetching it on every load and discarding the answer.
// The explicit key is shared with TokenScopeFields, which renders the same list:
// Nuxt keys per call site by default, so the two were fetching it twice.
const { data: toolCatalogue } = await useFetch<{ tools: McpToolInfo[] }>(
  () => `/api/instances/${props.instanceId}/mcp-tools`,
  { key: `mcp-tools-${props.instanceId}`, lazy: true, immediate: props.kind === 'postgres' },
)

function initialScope(): TokenScope {
  if (props.kind !== 'postgres') return openScope()
  const readTools = (toolCatalogue.value?.tools ?? []).filter(t => t.readOnly).map(t => t.name)
  return readOnlyScope(readTools)
}

/**
 * Seed the default selection when the catalogue lands.
 *
 * Without this, opening the dialog before the fetch settles produced
 * `{ all_tools: false, tool_names: [] }` — which `scopeSchema` refuses with
 * "Select at least one action", so Create failed with a validation error the
 * user did nothing to cause.
 */
watch(toolCatalogue, (catalogue) => {
  if (!createOpen.value || props.kind !== 'postgres' || !catalogue) return
  if (newScope.value.all_tools || newScope.value.tool_names.length > 0) return
  newScope.value = initialScope()
})

interface TokenRow {
  id: string
  label: string
  created?: string
  last_used_at?: string
  expires_at?: string
  revoked: boolean
  expired: boolean
  scope: TokenScope
}

const { data, refresh, status } = await useFetch<{ tokens: TokenRow[] }>(
  () => `/api/instances/${props.instanceId}/tokens`,
)

const createOpen = ref(false)
const newLabel = ref('')
const newExpiry = ref<'30d' | '90d' | '1y' | 'never'>('90d')
const newScope = ref<TokenScope>(openScope())
const revealed = ref<string | null>(null)
const revealedScope = ref<TokenScope>(openScope())
/** Which token is mid-revoke, so only that row's button is disabled. */
const revoking = ref<string | null>(null)

const editing = ref<TokenRow | null>(null)
const editScope = ref<TokenScope>(openScope())

const { busy: creating, run: runCreate } = useApiAction()
const { busy: savingScope, run: runSaveScope } = useApiAction()
const { run: runRevoke } = useApiAction()

const howTo = ref<TokenRow | null>(null)

/**
 * The how-to can only show a masked URL — the plaintext is gone after minting.
 * Hand off to the create flow, which is the one path that reveals a real one.
 */
function createFromHowTo() {
  howTo.value = null
  openCreate()
}

/**
 * Reset the form every time the dialog opens. Without this, a scope abandoned on
 * a previous open is what the next token is minted with.
 */
function openCreate() {
  newLabel.value = ''
  newExpiry.value = '90d'
  newScope.value = initialScope()
  createOpen.value = true
}

function startEdit(token: TokenRow) {
  editing.value = token
  // Copied, not referenced — cancelling must not leave the table showing edits
  // that were never saved. Deep, and without naming the array fields: a fifth
  // scope axis would otherwise be shared by reference and silently editable.
  editScope.value = structuredClone(token.scope)
}

async function saveScope() {
  const token = editing.value
  if (!token) return

  await runSaveScope(
    async () => {
      await $fetch(`/api/tokens/${token.id}`, { method: 'PATCH', body: editScope.value })
      editing.value = null
      await refresh()
    },
    {
      success: 'Scope updated. The connector keeps working with its existing token.',
      // The server rejects an empty allowlist by name — "Select at least one
      // action" — which is the whole point of showing its message here.
      failure: 'Could not update the scope',
    },
  )
}

async function create() {
  const scope = newScope.value

  const result = await runCreate(
    () => $fetch<{ token: string }>(`/api/instances/${props.instanceId}/tokens`, {
      method: 'POST',
      body: { label: newLabel.value, expiry: newExpiry.value, ...scope },
    }),
    { failure: 'Could not create the token' },
  )
  if (!result) return

  // The plaintext exists only in this response, so the reveal dialog is opened
  // from the value in hand rather than from a refetch.
  revealed.value = result.token
  revealedScope.value = scope
  createOpen.value = false
  newLabel.value = ''
  newScope.value = openScope()
  await refresh()
}

async function revoke(id: string) {
  revoking.value = id
  await runRevoke(
    async () => {
      await $fetch(`/api/tokens/${id}`, { method: 'DELETE' })
      await refresh()
    },
    {
      success: 'Token revoked',
      // A generic: this answers 404 for a token that is already gone, and
      // "Not found" is not a useful thing to show someone.
      failure: 'Could not revoke the token',
      preferServerMessage: false,
    },
  )
  revoking.value = null
}

function formatDate(value?: string) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function statusOf(token: TokenRow) {
  if (token.revoked) return { label: 'Revoked', variant: 'outline' as const }
  if (token.expired) return { label: 'Expired', variant: 'outline' as const }
  return { label: 'Active', variant: 'default' as const }
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h2 class="font-heading text-lg font-semibold">
          Connector tokens
        </h2>
        <p class="text-sm text-muted-foreground">
          Each token gives Claude access to this {{ describeKind(kind) }} and no other.
        </p>
        <p v-if="connected === false" class="mt-1 text-sm text-muted-foreground">
          <template v-if="kind === 'postgres'">
            This database is not reachable, so tokens cannot read or write
            anything until it is. You can still revoke them.
          </template>
          <template v-else>
            This account is not connected, so tokens cannot send or read anything
            until you pair it again. You can still revoke them.
          </template>
        </p>
      </div>

      <Button size="sm" @click="openCreate()">
        <PlusIcon class="size-4" />
        New token
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="status === 'pending'" class="space-y-2 p-6">
          <Skeleton class="h-5 w-full" />
          <Skeleton class="h-5 w-2/3" />
        </div>

        <p v-else-if="!data?.tokens?.length" class="p-6 text-sm text-muted-foreground">
          No tokens yet. Create one, then paste its URL into Claude as a custom connector.
        </p>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead class="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="token in data.tokens" :key="token.id">
              <TableCell class="font-medium">
                {{ token.label }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ formatDate(token.created) }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ token.last_used_at ? formatDate(token.last_used_at) : 'Never' }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ token.expires_at ? formatDate(token.expires_at) : 'Never' }}
              </TableCell>
              <TableCell>
                <span class="text-sm text-muted-foreground">{{ describeScope(token.scope, kind) }}</span>
              </TableCell>
              <TableCell>
                <Badge :variant="statusOf(token).variant">
                  {{ statusOf(token).label }}
                </Badge>
              </TableCell>
              <TableCell class="whitespace-nowrap">
                <Button
                  v-if="!token.revoked"
                  variant="ghost"
                  size="sm"
                  @click="howTo = token"
                >
                  How to
                </Button>
                <Button
                  v-if="!token.revoked"
                  variant="ghost"
                  size="sm"
                  @click="startEdit(token)"
                >
                  Edit
                </Button>
                <AlertDialog v-if="!token.revoked">
                  <AlertDialogTrigger as-child>
                    <Button variant="ghost" size="sm" :disabled="revoking === token.id">
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke “{{ token.label }}”?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Any Claude connector using this token stops working immediately.
                        This cannot be undone — you would need to create a new token.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction @click="revoke(token.id)">
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Dialog v-model:open="createOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New connector token</DialogTitle>
          <DialogDescription>
            Name it after where you will use it, so you know which to revoke later.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="token-label">Name</Label>
            <Input id="token-label" v-model="newLabel" placeholder="Claude desktop" />
          </div>

          <div class="space-y-2">
            <Label for="token-expiry">Expires</Label>
            <Select v-model="newExpiry">
              <SelectTrigger id="token-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30d">
                  In 30 days
                </SelectItem>
                <SelectItem value="90d">
                  In 90 days
                </SelectItem>
                <SelectItem value="1y">
                  In 1 year
                </SelectItem>
                <SelectItem value="never">
                  Never
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <TokenScopeFields v-model="newScope" :instance-id="instanceId" :kind="kind" />
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="createOpen = false">
            Cancel
          </Button>
          <Button :disabled="creating" @click="create">
            {{ creating ? 'Creating…' : 'Create token' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(editing)" @update:open="value => { if (!value) editing = null }">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit “{{ editing?.label }}”</DialogTitle>
          <DialogDescription>
            Changes apply from the next request. The connector already set up in
            Claude keeps working — the token itself does not change.
          </DialogDescription>
        </DialogHeader>

        <TokenScopeFields v-model="editScope" :instance-id="instanceId" :kind="kind" />

        <DialogFooter>
          <Button variant="ghost" @click="editing = null">
            Cancel
          </Button>
          <Button :disabled="savingScope" @click="saveScope">
            {{ savingScope ? 'Saving…' : 'Save scope' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <HowToConnectDialog
      :open="Boolean(howTo)"
      :kind="kind"
      :label="howTo?.label"
      :scope="howTo?.scope"
      @update:open="value => { if (!value) howTo = null }"
      @create="createFromHowTo"
    />

    <RevealTokenDialog :token="revealed" :kind="kind" :scope="revealedScope" @close="revealed = null" />
  </section>
</template>
