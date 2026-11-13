<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { assertNever } from '#shared/connection'

const props = withDefaults(defineProps<{
  instanceId: string
  kind: InstanceKind
  connected?: boolean
  /**
   * Whether this viewer manages the connection — an admin, or the member who
   * created it.
   *
   * A manager mints tokens, edits their scope, and sees every token on the
   * connection with who holds it. A member sees only their own and may revoke or
   * rotate them — destroying or replacing your own credential must never need
   * someone else's approval, and widening one must always be theirs.
   *
   * Presentation only: the server refuses each of these independently.
   */
  canManage?: boolean
}>(), { canManage: false })

const { user, isAdmin } = useSession()

/**
 * Whether a new token starts with the read tools only, which is also whether
 * the tool catalogue is fetched at all.
 *
 * A switch over the kind rather than a family test: a mailbox is a messaging
 * kind, yet starts read-only because drafting writes into it. A new kind
 * falling off the wrong side of this is not a cosmetic miss: the catalogue
 * never loads, `initialScope()` returns no tool names, and `scopeSchema` then
 * refuses Create with "Select at least one action" — a validation error the
 * user did nothing to cause.
 */
const startsReadOnly = computed(() => {
  switch (props.kind) {
    case 'postgres':
    case 'imap':
      return true
    case 'whatsapp':
    case 'telegram':
      return false
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

/**
 * A new token's starting scope depends on the kind.
 *
 * A WhatsApp or Telegram token starts open, as it always has. A Postgres or
 * mailbox token starts read-only — every read tool, no write tool (`run-statement`,
 * `create-email-draft`) — because the two mistakes do not
 * cost the same: a token that turns out to need writes is one edit away, and one
 * that turns out not to have needed them may already have made some.
 *
 * The read tools come from the server, since only it knows which exist.
 */
// Only a read-only-by-default token needs this, and only to seed its default
// scope — a WhatsApp dashboard was fetching it on every load and discarding the answer.
// The explicit key is shared with TokenScopeFields, which renders the same list:
// Nuxt keys per call site by default, so the two were fetching it twice.
const { data: toolCatalogue } = await useFetch<{ tools: McpToolInfo[] }>(
  () => `/api/instances/${props.instanceId}/mcp-tools`,
  { key: `mcp-tools-${props.instanceId}`, lazy: true, immediate: startsReadOnly.value },
)

function initialScope(): TokenScope {
  switch (props.kind) {
    case 'whatsapp':
    case 'telegram':
      return openScope()
    case 'postgres':
    case 'imap': {
      const readTools = (toolCatalogue.value?.tools ?? []).filter(t => t.readOnly).map(t => t.name)
      return readOnlyScope(readTools)
    }
    default:
      return assertNever(props.kind, 'connection kind')
  }
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
  if (!createOpen.value || !startsReadOnly.value || !catalogue) return
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
  /** The email is present only for a manager; another member's own list carries none. */
  assignedTo: { id: string, email?: string }
  scope: TokenScope
  send_disclaimer?: string
  /** Absent when the server could not read them; empty when none were seen. */
  clients?: TokenClient[]
  /** Set when a member asked for this token rather than a manager minting it. */
  request?: { requestedAt?: string, status: 'pending' | 'approved' | 'declined', requestedExpiry?: ExpiryChoice }
  /** False until the holder of an approved request has taken its secret. */
  secretIssued: boolean
}

type ExpiryChoice = '30d' | '90d' | '1y' | 'never'

const isPending = (token: TokenRow) => token.request?.status === 'pending' && !token.revoked
/** Approved, but its holder has not collected a secret: "Get token". */
const awaitsSecret = (token: TokenRow) => !token.secretIssued && !isPending(token) && !token.revoked && !token.expired

const { data, refresh, status } = await useFetch<{ tokens: TokenRow[] }>(
  () => `/api/instances/${props.instanceId}/tokens`,
)

const createOpen = ref(false)
const newLabel = ref('')
const newExpiry = ref<ExpiryChoice>('90d')
const newScope = ref<TokenScope>(openScope())
/** Off until an admin turns it on; see TokenScopeFields. */
const newDisclaimer = ref<string | null>(null)
const revealed = ref<string | null>(null)
const revealedScope = ref<TokenScope>(openScope())
/** Which token is mid-revoke, so only that row's button is disabled. */
const revoking = ref<string | null>(null)

const editing = ref<TokenRow | null>(null)
const editLabel = ref('')
const editScope = ref<TokenScope>(openScope())
const editDisclaimer = ref<string | null>(null)
/** Set when the edit dialog is approving a request rather than editing a token. */
const approving = ref(false)
const approveExpiry = ref<ExpiryChoice>('90d')

const { busy: creating, run: runCreate } = useApiAction()
const { busy: saving, run: runSave } = useApiAction()
const { run: runRevoke } = useApiAction()
const { run: runRotate } = useApiAction()

/** Which token is mid-rotate, so only that row's button is disabled. */
const rotating = ref<string | null>(null)

/**
 * Who a manager may issue a token to.
 *
 * Fetched only for a manager, and only for the create dialog. The server refuses
 * a token for someone who cannot reach the connection — it would be born dead —
 * so the picker offers exactly the people who can.
 */
const { data: assignable, refresh: refreshAssignable } = await useFetch<{
  members: { userId: string, email: string, role: OrgRole, assigned: boolean, implicit: boolean }[]
}>(() => `/api/instances/${props.instanceId}/assignments`, { immediate: false })

const newAssignee = ref<string>('')

const assigneeOptions = computed(() =>
  (assignable.value?.members ?? []).filter(m => m.implicit || m.assigned),
)

const howTo = ref<TokenRow | null>(null)
const clientsOf = ref<TokenRow | null>(null)
/** Whose tool-call history is open. See ToolCallsDialog. */
const callsOf = ref<TokenRow | null>(null)

/** The line under a token's name: its clients by name, newest session first. */
function clientSummary(token: TokenRow) {
  const distinct = distinctClients(token.clients ?? [])
  const shown = distinct.slice(0, 2).map(clientLabel).join(' · ')
  return distinct.length > 2 ? `${shown} +${distinct.length - 2} more` : shown
}

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
  newDisclaimer.value = null
  newAssignee.value = user.value?.id ?? ''
  createOpen.value = true
  if (props.canManage) refreshAssignable()
}

function startEdit(token: TokenRow, approve = false) {
  approving.value = approve
  approveExpiry.value = token.request?.requestedExpiry ?? '90d'
  editing.value = token
  editLabel.value = token.label
  // Copied, not referenced — cancelling must not leave the table showing edits
  // that were never saved. Deep, and without naming the array fields: a fifth
  // scope axis would otherwise be shared by reference and silently editable.
  editScope.value = structuredClone(token.scope)
  editDisclaimer.value = token.send_disclaimer ?? null
}

async function saveEdit() {
  const token = editing.value
  if (!token) return

  const approve = approving.value
  await runSave(
    async () => {
      const scope = { ...editScope.value, label: editLabel.value, send_disclaimer: disclaimerToSubmit(editScope.value, props.kind, editDisclaimer.value) }
      if (approve) {
        await $fetch(`/api/tokens/${token.id}/approve`, { method: 'POST', body: { ...scope, expiry: approveExpiry.value } })
        track('token_approved', { connection_id: props.instanceId, kind: props.kind, token_id: token.id, expiry: approveExpiry.value })
      }
      else {
        await $fetch(`/api/tokens/${token.id}`, { method: 'PATCH', body: scope })
      }
      editing.value = null
      await refresh()
    },
    {
      success: approve
        ? 'Request approved. They can now get the token from this page.'
        : 'Token updated. The connector keeps working with its existing token.',
      // The server rejects an empty allowlist or name by name — "Select at
      // least one action", "Give the token a name" — which is the whole point
      // of showing its message here.
      failure: approve ? 'Could not approve the request' : 'Could not update the token',
    },
  )
}

/**
 * Ask a manager for a token. Nothing is revealed: a request authenticates
 * nothing until approved, and the secret is collected afterwards ("Get token").
 */
async function request() {
  const scope = newScope.value
  const result = await runCreate(
    () => $fetch<{ notified: number }>(`/api/instances/${props.instanceId}/token-requests`, {
      method: 'POST',
      body: {
        label: newLabel.value,
        expiry: newExpiry.value,
        ...scope,
        send_disclaimer: disclaimerToSubmit(scope, props.kind, newDisclaimer.value),
      },
    }),
    { failure: 'Could not send the request' },
  )
  if (!result) return
  track('token_requested', { connection_id: props.instanceId, kind: props.kind, expiry: newExpiry.value })
  toast.success(result.notified
    ? 'Request sent. You will be able to get the token here once it is approved.'
    : 'Request saved. Whoever manages this connection will see it here; you can get the token once it is approved.')
  createOpen.value = false
  await refresh()
}

async function create() {
  const scope = newScope.value

  const result = await runCreate(
    () => $fetch<{ token: string }>(`/api/instances/${props.instanceId}/tokens`, {
      method: 'POST',
      body: {
        label: newLabel.value,
        expiry: newExpiry.value,
        assignedTo: newAssignee.value || undefined,
        ...scope,
        send_disclaimer: disclaimerToSubmit(scope, props.kind, newDisclaimer.value),
      },
    }),
    { failure: 'Could not create the token' },
  )
  if (!result) return
  track('token_created', {
    connection_id: props.instanceId,
    kind: props.kind,
    expiry: newExpiry.value,
    all_tools: scope.all_tools,
    tool_count: scope.tool_names.length,
    all_chats: scope.all_chats,
    all_tables: scope.all_tables,
    for_other_member: Boolean(newAssignee.value) && newAssignee.value !== user.value?.id,
  })

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
      track('token_revoked', { connection_id: props.instanceId, kind: props.kind, token_id: id })
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

/**
 * Replace a token's secret, keeping its scope.
 *
 * The one write a member may make to their own token: responding to a leak must
 * not queue behind an admin. The new plaintext is in the response and nowhere
 * else, so it goes straight into the reveal dialog rather than through a
 * refetch — the same rule as minting.
 */
async function rotate(token: TokenRow) {
  rotating.value = token.id
  const result = await runRotate(
    () => $fetch<{ token: string }>(`/api/tokens/${token.id}/rotate`, { method: 'POST' }),
    { failure: 'Could not issue a new secret' },
  )
  rotating.value = null
  if (!result) return

  revealed.value = result.token
  revealedScope.value = token.scope
  await refresh()
}

function statusOf(token: TokenRow) {
  if (token.request?.status === 'declined') return { label: 'Declined', variant: 'outline' as const }
  if (isPending(token)) return { label: 'Awaiting approval', variant: 'secondary' as const }
  if (token.revoked) return { label: 'Revoked', variant: 'outline' as const }
  if (awaitsSecret(token)) return { label: 'Approved', variant: 'secondary' as const }
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
          <template v-else-if="kind === 'whatsapp'">
            This account is not connected, so tokens cannot send or read anything
            until you pair it again. You can still revoke them.
          </template>
          <template v-else-if="kind === 'telegram'">
            This account is not connected, so tokens cannot send or read anything
            until it is linked again. You can still revoke them.
          </template>
          <template v-else-if="kind === 'imap'">
            This mailbox is not syncing, so tokens see only what was synced
            before and cannot fetch bodies or attachments until it works again.
            You can still revoke them.
          </template>
        </p>
      </div>

      <!-- Minting is manager-only: what a token reaches is the manager's
           decision, and any other member who could mint could grant themselves
           any scope the connection has. -->
      <Button v-if="canManage" size="sm" @click="openCreate()">
        <PlusIcon class="size-4" />
        New token
      </Button>
      <!-- Anyone else asks: the request is reviewed, and its scope may be
           changed, by whoever manages the connection. -->
      <Button v-else size="sm" variant="outline" @click="openCreate()">
        <PlusIcon class="size-4" />
        Request token
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="status === 'pending'" class="space-y-2 p-6">
          <Skeleton class="h-5 w-full" />
          <Skeleton class="h-5 w-2/3" />
        </div>

        <p v-else-if="!data?.tokens?.length" class="p-6 text-sm text-muted-foreground">
          <template v-if="canManage">
            No tokens yet. Create one, then paste its URL into Claude as a custom connector.
          </template>
          <template v-else>
            You have no connector tokens for this connection yet. Request one, and
            whoever manages this connection can approve it.
          </template>
        </p>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <!-- The last tool call. A client's last session is in the
                   clients dialog; they differ, and both are labelled. -->
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
                <!-- Whose it is, for a manager looking at everyone's tokens
                     on this connection. Under the name rather than in its own
                     column: a seventh column pushes the row actions off the
                     edge at ordinary widths. -->
                <div v-if="canManage" class="text-xs font-normal text-muted-foreground">
                  {{ token.assignedTo.id === user?.id ? 'You' : (token.assignedTo.email || 'Unknown holder') }}
                </div>
                <!-- Which MCP clients it was used from, as they named
                     themselves. A hint, not identity — the dialog says so.
                     Capped and wrapping, so a long client name cannot widen
                     the column and push the row actions off the edge. -->
                <button
                  v-if="token.clients?.length"
                  type="button"
                  class="mt-0.5 block max-w-40 text-left text-xs font-normal whitespace-normal text-muted-foreground [overflow-wrap:anywhere] underline-offset-2 hover:underline"
                  @click="clientsOf = token"
                >
                  {{ clientSummary(token) }}
                </button>
                <Badge v-if="token.clients?.some(c => c.newClient)" variant="secondary" class="mt-1">
                  New client
                </Badge>
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ formatDate(token.created) }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                <!-- Opens the token's recorded tool calls — admins only, the
                     server refuses everyone else. On the date rather than a row
                     button: the actions column is already as wide as an
                     ordinary screen allows. -->
                <button
                  v-if="token.last_used_at && isAdmin"
                  type="button"
                  class="underline-offset-2 hover:underline"
                  title="Show recorded tool calls"
                  @click="callsOf = token"
                >
                  {{ formatDate(token.last_used_at) }}
                </button>
                <template v-else-if="token.last_used_at">
                  {{ formatDate(token.last_used_at) }}
                </template>
                <template v-else>
                  Never
                </template>
              </TableCell>
              <TableCell class="text-muted-foreground">
                <!-- A request's clock starts at approval. -->
                <template v-if="isPending(token) || token.request?.status === 'declined'">
                  —
                </template>
                <template v-else>
                  {{ token.expires_at ? formatDate(token.expires_at) : 'Never' }}
                </template>
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
                <!-- A request: the manager approves (choosing the scope) or
                     declines; the requester may withdraw it. -->
                <template v-if="isPending(token)">
                  <Button
                    v-if="canManage"
                    size="sm"
                    @click="startEdit(token, true)"
                  >
                    Approve
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger as-child>
                      <Button variant="ghost" size="sm" :disabled="revoking === token.id">
                        {{ canManage ? 'Decline' : 'Withdraw' }}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{{ canManage ? 'Decline' : 'Withdraw' }} “{{ token.label }}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {{ canManage
                            ? 'No token is issued. They can send a new request.'
                            : 'The request is cancelled. You can send a new one.' }}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction @click="revoke(token.id)">
                          {{ canManage ? 'Decline' : 'Withdraw' }}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </template>
                <template v-else-if="!token.revoked">
                  <!-- Approved, secret not collected: only its holder can take
                       it, and the first secret anyone sees appears here. -->
                  <Button
                    v-if="awaitsSecret(token) && token.assignedTo.id === user?.id"
                    size="sm"
                    :disabled="rotating === token.id"
                    @click="rotate(token)"
                  >
                    Get token
                  </Button>
                  <Button
                    v-if="!awaitsSecret(token)"
                    variant="ghost"
                    size="sm"
                    @click="howTo = token"
                  >
                    How to
                  </Button>
                  <!-- Scope is manager-only. A token holder may replace the secret, never
                       widen what it reaches. -->
                  <Button
                    v-if="canManage && !token.revoked"
                    variant="ghost"
                    size="sm"
                    @click="startEdit(token)"
                  >
                    Edit
                  </Button>
                  <AlertDialog v-if="!token.revoked && !token.expired && !awaitsSecret(token)">
                    <AlertDialogTrigger as-child>
                      <Button variant="ghost" size="sm" :disabled="rotating === token.id">
                        New secret
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Issue a new secret for “{{ token.label }}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The current one stops working immediately and every Claude
                          connector using it has to be updated. What the token can
                          reach does not change. Use this if the token may have
                          leaked.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction @click="rotate(token)">
                          Issue a new secret
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
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
                </template>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Dialog v-model:open="createOpen">
      <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-5xl">
        <DialogHeader class="shrink-0">
          <DialogTitle>{{ canManage ? 'New connector token' : 'Request a connector token' }}</DialogTitle>
          <DialogDescription>
            Name it after where you will use it, so you know which to revoke later.
            <template v-if="!canManage">
              Whoever manages this connection reviews the request and may change
              what it can reach. Once approved, get the token from this page.
            </template>
          </DialogDescription>
        </DialogHeader>

        <!--
          The body takes the height left between header and footer, and the
          scope list inside it absorbs the slack — so the dialog itself does
          not scroll. overflow-y-auto here only bites on a very short viewport.
        -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div class="shrink-0 space-y-2">
            <Label for="token-label">Name</Label>
            <Input id="token-label" v-model="newLabel" placeholder="Claude desktop" />
          </div>

          <!--
            Only people who already reach this connection are offered: the
            server refuses a token for anyone else, because it would authenticate
            as nobody and answer 401 on every call while still rendering as
            "Active". Assigning the connection is a separate, deliberate act —
            see AssignConnectionDialog.
          -->
          <div v-if="assigneeOptions.length > 1" class="shrink-0 space-y-2">
            <Label for="token-assignee">Issue to</Label>
            <Select v-model="newAssignee">
              <SelectTrigger id="token-assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="member in assigneeOptions"
                  :key="member.userId"
                  :value="member.userId"
                >
                  {{ member.email }}{{ member.userId === user?.id ? ' (you)' : '' }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              They can revoke it or issue themselves a new secret for it, but not
              change what it reaches.
            </p>
          </div>

          <div class="shrink-0 space-y-2">
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

          <Separator class="shrink-0" />

          <TokenScopeFields
            v-model="newScope"
            v-model:disclaimer="newDisclaimer"
            :instance-id="instanceId"
            :kind="kind"
          />
        </div>

        <DialogFooter class="shrink-0">
          <Button variant="ghost" @click="createOpen = false">
            Cancel
          </Button>
          <Button v-if="canManage" :disabled="creating" @click="create">
            {{ creating ? 'Creating…' : 'Create token' }}
          </Button>
          <Button v-else :disabled="creating" @click="request">
            {{ creating ? 'Sending…' : 'Send request' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(editing)" @update:open="value => { if (!value) editing = null }">
      <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-5xl">
        <DialogHeader class="shrink-0">
          <DialogTitle>{{ approving ? 'Approve' : 'Edit' }} “{{ editing?.label }}”</DialogTitle>
          <DialogDescription v-if="approving">
            Requested by {{ editing?.assignedTo.email || 'a member' }}. This is the
            scope they asked for — change anything before approving. They get the
            token from this page afterwards; you will not see it.
          </DialogDescription>
          <DialogDescription v-else>
            Changes apply from the next request. The connector already set up in
            Claude keeps working — the token itself does not change.
          </DialogDescription>
        </DialogHeader>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div class="shrink-0 space-y-2">
            <Label for="edit-token-label">Name</Label>
            <Input id="edit-token-label" v-model="editLabel" />
          </div>

          <div v-if="approving" class="shrink-0 space-y-2">
            <Label for="approve-token-expiry">Expires</Label>
            <Select v-model="approveExpiry">
              <SelectTrigger id="approve-token-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30d">
                  30 days after approval
                </SelectItem>
                <SelectItem value="90d">
                  90 days after approval
                </SelectItem>
                <SelectItem value="1y">
                  1 year after approval
                </SelectItem>
                <SelectItem value="never">
                  Never
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator class="shrink-0" />

          <TokenScopeFields
            v-model="editScope"
            v-model:disclaimer="editDisclaimer"
            :instance-id="instanceId"
            :kind="kind"
          />
        </div>

        <DialogFooter class="shrink-0">
          <Button variant="ghost" @click="editing = null">
            Cancel
          </Button>
          <Button :disabled="saving" @click="saveEdit">
            {{ saving ? 'Saving…' : approving ? 'Approve' : 'Save' }}
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

    <ToolCallsDialog
      :open="Boolean(callsOf)"
      :token-id="callsOf?.id"
      :label="callsOf?.label"
      @update:open="value => { if (!value) callsOf = null }"
    />

    <TokenClientsDialog
      :open="Boolean(clientsOf)"
      :label="clientsOf?.label"
      :clients="clientsOf?.clients ?? []"
      @update:open="value => { if (!value) clientsOf = null }"
    />

    <RevealTokenDialog :token="revealed" :kind="kind" :scope="revealedScope" @close="revealed = null" />
  </section>
</template>
