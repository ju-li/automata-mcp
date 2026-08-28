<script setup lang="ts">
import { TriangleAlertIcon } from '@lucide/vue'

const props = defineProps<{ token: string | null, scope?: TokenScope }>()
const emit = defineEmits<{ close: [] }>()

const { connectorUrl } = useConnectorUrl()

/** The one place the real token is known, so the URL here is never masked. */
const url = computed(() => (props.token ? connectorUrl(props.token) : ''))

const open = computed({
  get: () => Boolean(props.token),
  set: (value: boolean) => {
    if (!value) emit('close')
  },
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="overflow-hidden sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Your connector token</DialogTitle>
        <DialogDescription>
          Copy it now. It is stored only as a hash, so this is the one and only time
          it can be shown.
        </DialogDescription>
      </DialogHeader>

      <div class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
        <p>
          Anyone with this token can read and send WhatsApp messages from this
          account. Treat it like a password.
        </p>
      </div>

      <p v-if="scope" class="text-sm">
        <span class="text-muted-foreground">Scope:</span> {{ describeScope(scope) }}
      </p>

      <div class="min-w-0 space-y-2">
        <Label>Connector URL — paste this into Claude</Label>
        <CopyableSnippet :value="url" aria-label="Copy connector URL" />
      </div>

      <div class="min-w-0 space-y-2">
        <Label>Token on its own</Label>
        <CopyableSnippet :value="token || ''" aria-label="Copy token" />
        <p class="text-xs text-muted-foreground">
          For clients that can send <code class="font-mono break-all">Authorization: Bearer</code>, point them at <code class="font-mono">/mcp</code> and use this instead.
        </p>
      </div>

      <DialogFooter>
        <Button @click="emit('close')">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
