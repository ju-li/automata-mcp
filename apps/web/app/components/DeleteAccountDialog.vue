<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * Delete your own account, from the profile page.
 *
 * The dialog asks the server what the deletion would take with it
 * (`GET /api/auth/account/deletion`) each time it opens and says so before
 * anything else: just the account, the account plus the organization and every
 * connection in it when you are its only member, or nothing at all when you are
 * the only admin of an organization that has other members. The server decides
 * again at delete time and refuses (409) when the answer changed, so a stale
 * preview cannot delete something this dialog did not name.
 *
 * Two gates: the current password, which the server checks; and typing
 * `DELETE`, a typo guard that never leaves the browser.
 */

interface DeletionPreview {
  mode: 'account' | 'account-and-org' | 'blocked'
  org?: { name: string, role: 'admin' | 'member' }
  connections: { id: string, label: string, kind: string }[]
  liveTokens: number
  blockedReason?: string
}

const KIND_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  postgres: 'PostgreSQL',
  imap: 'Email',
}

const { user, membership, loaded } = useSession()
const hosted = useHosted()

const open = ref(false)
const preview = ref<DeletionPreview | null>(null)
const previewError = ref('')
const loadingPreview = ref(false)
const password = ref('')
const confirmation = ref('')

const { busy, run } = useApiAction()

const confirmed = computed(() => confirmation.value === 'DELETE' && Boolean(password.value))

/** A paid plan is cancelled with the organization — worth saying, hosted only. */
const cancelsPlan = computed(() => {
  const plan = membership.value?.org.plan
  return hosted.value && preview.value?.mode === 'account-and-org' && Boolean(plan) && plan !== 'Free'
})

watch(open, async (isOpen) => {
  password.value = ''
  confirmation.value = ''
  if (!isOpen) return

  preview.value = null
  previewError.value = ''
  loadingPreview.value = true
  try {
    preview.value = await $fetch<DeletionPreview>('/api/auth/account/deletion')
  }
  catch (error) {
    previewError.value = apiErrorMessage(error, 'Could not check what deleting your account would do.')
  }
  finally {
    loadingPreview.value = false
  }
})

async function destroy() {
  if (!confirmed.value) return

  const result = await run(async () => {
    return await $fetch<{ orgDeleted: boolean, connectionsDeleted: number }>('/api/auth/account/delete', {
      method: 'POST',
      body: { currentPassword: password.value },
    })
  }, { failure: 'Could not delete your account', keepBusyOnSuccess: true })

  if (!result) {
    password.value = ''
    return
  }

  // The session died with the account; drop what the browser still holds of it.
  user.value = null
  membership.value = null
  loaded.value = true
  open.value = false
  toast.success(result.orgDeleted
    ? 'Your account and organization were deleted.'
    : 'Your account was deleted.')
  await navigateTo('/login')
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="destructive" size="sm">
        Delete account
      </Button>
    </DialogTrigger>

    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Delete your account?</DialogTitle>
        <DialogDescription>
          This permanently deletes the account {{ user?.email }}. It cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <p v-if="loadingPreview" class="text-sm text-muted-foreground">
        Checking what this would delete…
      </p>

      <p v-else-if="previewError" class="text-sm text-destructive">
        {{ previewError }}
      </p>

      <template v-else-if="preview">
        <div v-if="preview.mode === 'blocked'" class="space-y-3 text-sm">
          <p>{{ preview.blockedReason }}</p>
          <Button as-child size="sm" variant="outline">
            <NuxtLink to="/team" @click="open = false">
              Go to the Organization page
            </NuxtLink>
          </Button>
        </div>

        <form v-else class="space-y-4" @submit.prevent="destroy">
          <div class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <template v-if="preview.mode === 'account-and-org'">
              <p v-if="preview.org">
                You are the only member of <span class="font-medium">{{ preview.org.name }}</span>,
                so the organization is deleted too<template v-if="preview.connections.length">,
                  with every connection in it:</template><template v-else>.</template>
              </p>
              <ul v-if="preview.connections.length" class="list-disc space-y-0.5 pl-5">
                <li v-for="connection in preview.connections" :key="connection.id">
                  {{ connection.label }}
                  <span class="text-muted-foreground">({{ KIND_NAMES[connection.kind] ?? connection.kind }})</span>
                </li>
              </ul>
              <p v-if="preview.connections.length">
                Everything stored for them — messages, chats, email headers —
                is deleted, and every connector token stops working. Your
                databases and mailboxes themselves are not touched.
              </p>
              <p v-if="cancelsPlan">
                The organization's paid plan is cancelled.
              </p>
            </template>

            <template v-else>
              <p v-if="preview.org">
                Your organization <span class="font-medium">{{ preview.org.name }}</span>
                and its connections stay; you are removed from it.
              </p>
              <p v-if="preview.liveTokens">
                {{ preview.liveTokens }} connector token{{ preview.liveTokens === 1 ? '' : 's' }}
                issued to you stop{{ preview.liveTokens === 1 ? 's' : '' }} working.
              </p>
            </template>
          </div>

          <div class="space-y-2">
            <Label for="delete-account-password">Current password</Label>
            <Input
              id="delete-account-password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </div>

          <div class="space-y-2">
            <Label for="delete-account-confirm">Type <span class="font-mono">DELETE</span> to confirm</Label>
            <Input
              id="delete-account-confirm"
              v-model="confirmation"
              autocomplete="off"
              :disabled="busy"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" :disabled="busy" @click="open = false">
              Cancel
            </Button>
            <Button type="submit" variant="destructive" :disabled="!confirmed || busy">
              {{ busy ? 'Deleting…' : 'Delete permanently' }}
            </Button>
          </DialogFooter>
        </form>
      </template>
    </DialogContent>
  </Dialog>
</template>
