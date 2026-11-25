<script setup lang="ts">
import { KeyRoundIcon } from '@lucide/vue'

const props = defineProps<{
  open: boolean
  kind: InstanceKind
  /** The token's name, so the dialog says which one it is describing. */
  label?: string
  scope?: TokenScope
  /** The connection's tool catalogue, so the scope line accounts for opt-in actions. */
  tools?: readonly McpToolInfo[]
  /**
   * The plaintext token, known only in the moment it is minted. Everywhere else
   * the list endpoint has no token material to give, so the URL is masked.
   */
  token?: string | null
}>()

const emit = defineEmits<{ 'update:open': [boolean], 'create': [] }>()

const known = computed(() => Boolean(props.token))
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {{ label ? `How to connect “${label}”` : 'How to connect' }}
        </DialogTitle>
        <DialogDescription>
          This token adds one {{ describeKind(kind) }} to your AI assistant. Pick yours — the steps differ.
        </DialogDescription>
      </DialogHeader>

      <p v-if="scope" class="text-sm">
        <span class="text-muted-foreground">Scope:</span> {{ describeScope(scope, kind, tools) }}
      </p>

      <div v-if="!known" class="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
        <div class="flex items-start gap-2">
          <KeyRoundIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            The token is shown once, when it is created — only a hash is stored, so
            it cannot be recovered. It is masked below. If you no longer have it,
            create a new token and revoke this one.
          </p>
        </div>
        <Button variant="outline" size="sm" @click="emit('create')">
          Create new token
        </Button>
      </div>

      <ConnectInstructions :kind="kind" :token="token" />

      <DialogFooter>
        <Button @click="emit('update:open', false)">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
