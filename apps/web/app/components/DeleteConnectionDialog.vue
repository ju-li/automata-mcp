<script setup lang="ts">
/**
 * Remove a connection, behind a typed confirmation.
 *
 * Shared by both dashboard panels rather than duplicated in each: the flow is
 * identical — same typed `delete` gate, same navigation away, same "the row and
 * its tokens go, the remote thing may not" reasoning — and only the prose
 * differs by kind. The panels themselves stay separate; this is one part of
 * them, not the whole.
 *
 * What the deletion actually releases per kind is `deleteInstance()`'s business,
 * not this dialog's. All the wording has to get right is what the owner loses.
 */
const props = defineProps<{ id: string, label?: string, kind: InstanceKind }>()

const { busy, run } = useApiAction()
const confirmation = ref('')

/** Typed exactly, or the button stays disabled. */
const confirmed = computed(() => confirmation.value === 'delete')

async function destroy() {
  await run(
    async () => {
      await $fetch(`/api/instances/${props.id}`, { method: 'DELETE' })
      await navigateTo('/instances')
    },
    {
      success: props.kind === 'postgres' ? 'Connection removed' : 'Account removed',
      // A generic, deliberately: the failures here answer "Not found" or "Not
      // signed in", which is a worse thing to show someone than this sentence.
      failure: props.kind === 'postgres'
        ? 'Could not remove the connection'
        : 'Could not remove the account',
      preferServerMessage: false,
      // Navigating away — clearing the flag would re-enable a button on a page
      // that is already going.
      keepBusyOnSuccess: true,
    },
  )
}
</script>

<template>
  <AlertDialog>
    <AlertDialogTrigger as-child>
      <Button variant="destructive" :disabled="busy">
        {{ kind === 'postgres' ? 'Remove connection' : 'Remove account' }}
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove “{{ label }}”?</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="kind === 'postgres'">
            This deletes the stored connection string and every connector token
            issued for it, and Claude immediately loses access. Your database
            and its data are not touched. This cannot be undone.
          </template>
          <template v-else>
            This permanently deletes the connection, every message and chat
            stored for it, and every connector token issued for it. Claude will
            immediately lose access. This cannot be undone.
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div class="space-y-2">
        <Label for="confirm">Type <span class="font-mono">delete</span> to confirm</Label>
        <Input id="confirm" v-model="confirmation" autocomplete="off" />
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel @click="confirmation = ''">
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction :disabled="!confirmed || busy" @click="destroy">
          Remove permanently
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
