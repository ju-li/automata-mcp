<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

const props = defineProps<{ instanceId: string, connected?: boolean }>()

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
const creating = ref(false)
const revealed = ref<string | null>(null)
const revealedScope = ref<TokenScope>(openScope())
const revoking = ref<string | null>(null)

const editing = ref<TokenRow | null>(null)
const editScope = ref<TokenScope>(openScope())
const savingScope = ref(false)

function startEdit(token: TokenRow) {
  editing.value = token
  // Copied, not referenced — cancelling must not leave the table showing edits
  // that were never saved.
  editScope.value = { ...token.scope, tool_names: [...token.scope.tool_names], chat_jids: [...token.scope.chat_jids] }
}

async function saveScope() {
  if (!editing.value) return
  savingScope.value = true
  try {
    await $fetch(`/api/tokens/${editing.value.id}`, { method: 'PATCH', body: editScope.value })
    toast.success('Scope updated. The connector keeps working with its existing token.')
    editing.value = null
    await refresh()
  }
  catch (err: any) {
    toast.error(err?.data?.message || 'Could not update the scope')
  }
  finally {
    savingScope.value = false
  }
}

async function create() {
  creating.value = true
  try {
    const result = await $fetch<{ token: string }>(`/api/instances/${props.instanceId}/tokens`, {
      method: 'POST',
      body: { label: newLabel.value, expiry: newExpiry.value, ...newScope.value },
    })
    revealed.value = result.token
    revealedScope.value = newScope.value
    createOpen.value = false
    newLabel.value = ''
    newScope.value = openScope()
    await refresh()
  }
  catch (err: any) {
    toast.error(err?.data?.message || 'Could not create the token')
  }
  finally {
    creating.value = false
  }
}

async function revoke(id: string) {
  revoking.value = id
  try {
    await $fetch(`/api/tokens/${id}`, { method: 'DELETE' })
    toast.success('Token revoked')
    await refresh()
  }
  catch {
    toast.error('Could not revoke the token')
  }
  finally {
    revoking.value = null
  }
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
          Each token gives Claude access to this WhatsApp account and no other.
        </p>
        <p v-if="connected === false" class="mt-1 text-sm text-muted-foreground">
          This account is not connected, so tokens cannot send or read anything
          until you pair it again. You can still revoke them.
        </p>
      </div>

      <Button size="sm" @click="createOpen = true">
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
                <span class="text-sm text-muted-foreground">{{ describeScope(token.scope) }}</span>
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

          <TokenScopeFields v-model="newScope" :instance-id="instanceId" />
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

        <TokenScopeFields v-model="editScope" :instance-id="instanceId" />

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

    <RevealTokenDialog :token="revealed" :scope="revealedScope" @close="revealed = null" />
  </section>
</template>
