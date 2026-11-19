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
 * The member who created the connection is marked: they manage it only while
 * they keep access, so taking it away also takes away management. They cannot
 * remove themselves (the server refuses); an admin can.
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
  creator: boolean
  tokens: number
}

const { user } = useSession()

const open = ref(false)
const pending = ref<string | null>(null)

/** A pending member invitation; admins only (the server sends none to anyone else). */
interface AssignableInvite {
  inviteId: string
  email: string
  assigned: boolean
}

const { data, refresh, status } = await useFetch<{ members: AssignableMember[], invites?: AssignableInvite[] }>(
  () => `/api/instances/${props.id}/assignments`,
  // Only when the dialog is actually opened: this is a manager-only route and a
  // member's dashboard must not fire it on every page load.
  { immediate: false },
)

watch(open, (value) => {
  if (value) refresh()
})

const assignable = computed(() => (data.value?.members ?? []).filter(m => !m.implicit))
const admins = computed(() => (data.value?.members ?? []).filter(m => m.implicit))
const invites = computed(() => data.value?.invites ?? [])

/**
 * Someone invited but not yet joined. The connection is theirs from the moment
 * they accept; until then nothing happens, and there are no tokens to revoke.
 */
async function toggleInvite(invite: AssignableInvite) {
  pending.value = `invite:${invite.inviteId}`
  try {
    if (invite.assigned) {
      await $fetch(`/api/instances/${props.id}/assignments/invites/${invite.inviteId}`, { method: 'DELETE' })
    }
    else {
      await $fetch(`/api/instances/${props.id}/assignments`, { method: 'POST', body: { inviteId: invite.inviteId } })
    }
    await refresh()
    toast.success(invite.assigned
      ? `${invite.email} will not get this ${describeKind(props.kind)} when they join.`
      : `${invite.email} gets this ${describeKind(props.kind)} when they accept their invitation.`)
  } catch (error) {
    showErrorToast(error, { title: invite.assigned ? 'Could not remove the assignment' : 'Could not assign the connection' })
  } finally {
    pending.value = null
  }
}

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
    showErrorToast(error, { title: 'Could not assign the connection' })
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
    showErrorToast(error, { title: 'Could not remove the assignment' })
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
          <p v-if="!assignable.length && !invites.length" class="text-sm text-muted-foreground">
            Everyone in this organization is an admin, and admins already reach
            every connection. Invite someone as a member to assign connections to
            them.
          </p>

          <ul v-if="assignable.length" class="divide-y rounded-md border">
            <li
              v-for="member in assignable"
              :key="member.userId"
              class="flex items-center justify-between gap-3 p-3"
            >
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">
                  {{ member.email }}
                </div>
                <div v-if="member.creator" class="text-xs text-muted-foreground">
                  Created this connection{{ member.assigned ? ' — removing access also ends their management of it' : '' }}
                </div>
                <div v-if="member.assigned && member.tokens" class="text-xs text-muted-foreground">
                  {{ member.tokens }} connector token(s) — removing access revokes them
                </div>
              </div>

              <span v-if="member.userId === user?.id" class="text-xs text-muted-foreground">
                You
              </span>
              <Button
                v-else
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

          <!-- Pending member invitations (admins only). The connection is
               given on acceptance; an admin invitation is left out, since
               admins reach everything. -->
          <ul v-if="invites.length" class="divide-y rounded-md border">
            <li
              v-for="invite in invites"
              :key="invite.inviteId"
              class="flex items-center justify-between gap-3 p-3"
            >
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium">{{ invite.email }}</span>
                  <Badge variant="secondary">
                    Invited
                  </Badge>
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ invite.assigned ? 'Gets access when they accept the invitation' : 'Has not accepted their invitation yet' }}
                </div>
              </div>

              <Button
                size="sm"
                :variant="invite.assigned ? 'ghost' : 'outline'"
                :class="invite.assigned ? 'text-destructive' : ''"
                :disabled="pending === `invite:${invite.inviteId}`"
                @click="toggleInvite(invite)"
              >
                {{ invite.assigned ? 'Remove access' : 'Give access' }}
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
