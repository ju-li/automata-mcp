<script setup lang="ts">
import { UserPlusIcon } from '@lucide/vue'

/**
 * Invite someone by email address.
 *
 * The address is not optional and not cosmetic: acceptance requires the
 * accepting account's own email to match, so a link that leaks cannot be
 * redeemed by whoever reads it first. The copy says so, because an admin who
 * thinks the link alone grants access will hand it out carelessly.
 */
const emit = defineEmits<{ created: [RevealedInvite] }>()

const open = ref(false)
const email = ref('')
const role = ref<OrgRole>('member')
const { busy, run } = useApiAction()

watch(open, (value) => {
  if (!value) return
  email.value = ''
  role.value = 'member'
})

async function submit() {
  const address = email.value.trim()
  if (!address) return

  await run(async () => {
    const result = await $fetch<{ url: string, code: string, invite: { id: string, email: string } }>('/api/org/invites', {
      method: 'POST',
      body: { email: address, role: role.value },
    })
    open.value = false
    emit('created', {
      id: result.invite.id,
      code: result.code,
      url: result.url,
      email: result.invite.email,
      role: role.value,
    })
  }, { failure: 'Could not create the invitation' })
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button size="sm">
        <UserPlusIcon class="size-4" />
        Invite someone
      </Button>
    </DialogTrigger>

    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Invite someone</DialogTitle>
        <DialogDescription>
          You will get a link to copy, or to email to them from the next step.
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-2">
          <Label for="invite-email">Email address</Label>
          <Input
            id="invite-email"
            v-model="email"
            type="email"
            required
            autocomplete="off"
            placeholder="colleague@example.com"
          />
          <p class="text-xs text-muted-foreground">
            The link only works for this address — they have to sign in as it to
            accept.
          </p>
        </div>

        <div class="space-y-2">
          <Label for="invite-role">Role</Label>
          <Select v-model="role">
            <SelectTrigger id="invite-role" class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">
                Member
              </SelectItem>
              <SelectItem value="admin">
                Admin
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            {{ describeRoleCapabilities(role) }}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="open = false">
            Cancel
          </Button>
          <Button type="submit" :disabled="busy || !email.trim()">
            Create link
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
