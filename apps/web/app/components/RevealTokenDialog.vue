<script setup lang="ts">
import { CheckIcon, CopyIcon, TriangleAlertIcon } from '@lucide/vue'

const props = defineProps<{ token: string | null, scope?: TokenScope }>()
const emit = defineEmits<{ close: [] }>()

const config = useRuntimeConfig()

/**
 * The path form is what most people need: Claude's custom connectors cannot
 * attach an Authorization header, so the token has to ride in the URL.
 */
const connectorUrl = computed(() => {
  if (!props.token) return ''
  const origin = config.public.appUrl || (import.meta.client ? window.location.origin : '')
  return `${origin}/mcp/${props.token}`
})

const open = computed({
  get: () => Boolean(props.token),
  set: (value: boolean) => {
    if (!value) emit('close')
  },
})

const copied = ref<'url' | 'token' | null>(null)

async function copy(what: 'url' | 'token') {
  const value = what === 'url' ? connectorUrl.value : props.token
  if (!value) return
  await navigator.clipboard.writeText(value)
  copied.value = what
  setTimeout(() => (copied.value = null), 2000)
}
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
        <div class="flex min-w-0 items-center gap-2">
          <code class="block min-w-0 flex-1 select-all truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">{{ connectorUrl }}</code>
          <Button variant="outline" size="icon" class="shrink-0" aria-label="Copy connector URL" @click="copy('url')">
            <CheckIcon v-if="copied === 'url'" class="size-4" />
            <CopyIcon v-else class="size-4" />
          </Button>
        </div>
      </div>

      <div class="min-w-0 space-y-2">
        <Label>Token on its own</Label>
        <div class="flex min-w-0 items-center gap-2">
          <code class="block min-w-0 flex-1 select-all truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">{{ token }}</code>
          <Button variant="outline" size="icon" class="shrink-0" aria-label="Copy token" @click="copy('token')">
            <CheckIcon v-if="copied === 'token'" class="size-4" />
            <CopyIcon v-else class="size-4" />
          </Button>
        </div>
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
