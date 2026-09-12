<script setup lang="ts">
/**
 * The one and only showing of an invitation link.
 *
 * Same contract as `RevealTokenDialog`: the plaintext code exists in the create
 * response and nowhere else, so this is the only moment it can be copied. The
 * copy button distinguishes a failed copy from a successful one for exactly that
 * reason — see `CopyableSnippet`.
 */
const props = defineProps<{
  url: string | null
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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Invitation link</DialogTitle>
        <DialogDescription>
          Send this to {{ email }}. They join as
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
            invite the same address again — that replaces this link.
          </p>
        </div>

        <CopyableSnippet v-if="url" :value="url" wrap aria-label="Copy invitation link" />

        <p class="text-xs text-muted-foreground">
          Expires in 14 days. Anyone who opens it still has to sign in as
          {{ email }} to accept.
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
