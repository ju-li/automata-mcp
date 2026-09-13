<script setup lang="ts">
import { MailIcon } from '@lucide/vue'

/**
 * The one and only showing of an invitation link.
 *
 * Same contract as `RevealTokenDialog`: the plaintext code exists in the create
 * response and nowhere else, so this is the only moment it can be copied. The
 * copy button distinguishes a failed copy from a successful one for exactly that
 * reason — see `CopyableSnippet`.
 *
 * Emailing it is offered here rather than at creation so that a mail failure
 * never costs the admin the link: it is already on screen when they press Send.
 * The server mails only the address stored on the invitation, and only when
 * handed the code, so the button cannot be pointed anywhere else.
 */
const props = defineProps<{
  url: string | null
  inviteId?: string
  code?: string
  email?: string
  role?: OrgRole
}>()

const emit = defineEmits<{ close: [] }>()

const open = computed({
  get: () => Boolean(props.url),
  set: (value: boolean) => {
    if (!value) emit('close')
  },
})

const { busy, run } = useApiAction()
const sent = ref(false)

// A new link is a new invitation; a previous one having been mailed says
// nothing about this one.
watch(() => props.url, () => {
  sent.value = false
})

async function sendEmail() {
  if (!props.inviteId || !props.code) return

  await run(async () => {
    await $fetch(`/api/org/invites/${props.inviteId}/email`, {
      method: 'POST',
      body: { code: props.code },
    })
    sent.value = true
  }, { success: `Invitation emailed to ${props.email}.`, failure: 'Could not send the email' })
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Invitation link</DialogTitle>
        <DialogDescription>
          Copy it or email it to {{ email }}. They join as
          {{ role === 'admin' ? 'an admin' : 'a member' }}, and the link works
          only for that address.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p class="font-medium text-destructive">
            Shown once
          </p>
          <p class="mt-1 text-muted-foreground">
            The link is not stored and cannot be shown again. If you lose it,
            resend the invitation — that replaces this link.
          </p>
        </div>

        <CopyableSnippet v-if="url" :value="url" wrap aria-label="Copy invitation link" />

        <p class="text-xs text-muted-foreground">
          Expires in 14 days. Anyone who opens it still has to sign in as
          {{ email }} to accept.
        </p>
      </div>

      <DialogFooter>
        <Button
          v-if="inviteId && code"
          variant="outline"
          :disabled="busy || sent"
          @click="sendEmail()"
        >
          <MailIcon class="size-4" />
          {{ sent ? 'Email sent' : 'Send invite email' }}
        </Button>
        <Button variant="outline" @click="emit('close')">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
