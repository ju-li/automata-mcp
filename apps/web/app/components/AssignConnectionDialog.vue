<script setup lang="ts">
import { UsersIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * Who in the organization may use this connection.
 *
 * "Use" and not "manage": an assignment grants the dashboard and the right to
 * hold connector tokens on it, never the right to change, reconnect or delete
 * it. The copy says so, because "give someone access" is otherwise read as
 * giving them everything.
 *
 * Admins appear in the list but cannot be toggled — they already reach every
 * connection in the organization, and a checkbox that does nothing is worse than
 * no checkbox.
 *
 * Unassigning revokes that person's tokens on this connection. That is not a
 * side effect worth hiding: the alternative is a token that still reads "Active"
 * and answers 401 on every call. The count is shown before the click, not after.
 */
const props = defineProps<{
  id: string
  kind: InstanceKind
}>()

interface AssignableMember {
  userId: string
  email: string
  role: OrgRole
  assigned: boolean
  implicit: boolean
  tokens: number
}

const open = ref(false)
const pending = ref<string | null>(null)

const { data, refresh, status } = await useFetch<{ members: AssignableMember[] }>(
  () => `/api/instances/${props.id}/assignments`,
  // Only when the dialog is actually opened: this is an admin-only route and a
  // member's dashboard must not fire it on every page load.
  { immediate: false },
)

watch(open, (value) => {
  if (value) refresh()
})

const assignable = computed(() => (data.value?.members ?? []).filter(m => !m.implicit))
const admins = computed(() => (data.value?.members ?? []).filter(m => m.implicit))

async function assign(member: AssignableMember) {
  pending.value = member.userId
  try {
    await $fetch(`/api/instances/${props.id}/assignments`, {
      method: 'POST',
      body: { userId: member.userId },
    })
    await refresh()
    toast.success(`${member.email} can now use this ${describeKind(props.kind)}.`)
  } catch (error) {
    toast.error(apiErrorMessage(error, 'Could not assign the connection'))
  } finally {
    pending.value = null
  }
}

async function unassign(member: AssignableMember) {
  pending.value = member.userId
  try {
    const result = await $fetch<{ revokedTokens: number }>(
      `/api/instances/${props.id}/assignments/${member.userId}`,
      { method: 'DELETE' },
    )
    await refresh()
    toast.success(result.revokedTokens
      ? `${member.email} no longer has access. ${result.revokedTokens} token(s) revoked.`
      : `${member.email} no longer has access.`)
  } catch (error) {
    toast.error(apiErrorMessage(error, 'Could not remove the assignment'))
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline">
        <UsersIcon class="size-4" />
        Who can use this
      </Button>
    </DialogTrigger>

    <DialogScrollContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Who can use this connection</DialogTitle>
        <DialogDescription>
          People you add here get its dashboard and can hold connector tokens on
          it. They cannot change, reconnect or delete it.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <Skeleton v-if="status === 'pending' || status === 'idle'" class="h-32" />

        <template v-else>
          <p v-if="!assignable.length" class="text-sm text-muted-foreground">
            Everyone in this organization is an admin, and admins already reach
            every connection. Invite someone as a member to assign connections to
            them.
          </p>

          <ul v-else class="divide-y rounded-md border">
            <li
              v-for="member in assignable"
              :key="member.userId"
              class="flex items-center justify-between gap-3 p-3"
            >
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">
                  {{ member.email }}
                </div>
                <div v-if="member.assigned && member.tokens" class="text-xs text-muted-foreground">
                  {{ member.tokens }} connector token(s) — removing access revokes them
                </div>
              </div>

              <Button
                size="sm"
                :variant="member.assigned ? 'ghost' : 'outline'"
                :class="member.assigned ? 'text-destructive' : ''"
                :disabled="pending === member.userId"
                @click="member.assigned ? unassign(member) : assign(member)"
              >
                {{ member.assigned ? 'Remove access' : 'Give access' }}
              </Button>
            </li>
          </ul>

          <p v-if="admins.length" class="text-xs text-muted-foreground">
            {{ admins.map(a => a.email).join(', ') }}
            {{ admins.length === 1 ? 'is an admin and already reaches' : 'are admins and already reach' }}
            every connection in this organization.
          </p>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">
          Done
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
