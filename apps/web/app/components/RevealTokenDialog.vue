<script setup lang="ts">
import { TriangleAlertIcon } from '@lucide/vue'

const props = defineProps<{ token: string | null, kind: InstanceKind, scope?: TokenScope, tools?: readonly McpToolInfo[] }>()
const emit = defineEmits<{ close: [] }>()

const open = computed({
  get: () => Boolean(props.token),
  set: (value: boolean) => {
    if (!value) emit('close')
  },
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[85vh] overflow-x-hidden overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Your connector token</DialogTitle>
        <DialogDescription>
          Copy it now. It is stored only as a hash, so this is the one and only time
          it can be shown.
        </DialogDescription>
      </DialogHeader>

      <div class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
        <p v-if="kind === 'postgres'">
          Anyone with this token can query this database — and write to it, if you
          granted the write action. Treat it like a password.
        </p>
        <p v-else-if="kind === 'whatsapp'">
          Anyone with this token can read and send WhatsApp messages from this
          account. Treat it like a password.
        </p>
        <p v-else-if="kind === 'telegram'">
          Anyone with this token can read and send Telegram messages from this
          account. Treat it like a password.
        </p>
        <p v-else-if="kind === 'imap'">
          Anyone with this token can read the email in this mailbox, attachments
          included — and save drafts in it, if you granted that action. Treat it
          like a password.
        </p>
      </div>

      <p v-if="scope" class="text-sm">
        <span class="text-muted-foreground">Scope:</span> {{ describeScope(scope, kind, tools) }}
      </p>

      <ConnectInstructions :kind="kind" :token="token" />

      <DialogFooter>
        <Button @click="emit('close')">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
