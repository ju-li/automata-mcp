<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * Your own account: display name, email address, password.
 *
 * Three stacked sections rather than tabs, each with its own submit button and
 * its own busy flag. They are three independent writes against three routes, and
 * a shared flag would grey out the two you are not using — the same reasoning
 * `McpTokens.vue` applies per row.
 *
 * Changing the email or the password asks for the current password. The session
 * cookie is `httpOnly` but a signed-in browser left open is enough to use it, so
 * the password is what separates "someone walked up to an unlocked laptop" from
 * "someone took the account". The server refuses a wrong one with a 403, never a
 * 401 — a 401 would read as being signed out mid-edit.
 */
const open = defineModel<boolean>('open', { required: true })

const { user, refresh } = useSession()

const name = ref('')
const email = ref('')
const emailPassword = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const mismatch = ref('')

const { busy: nameBusy, run: runName } = useApiAction()
const { busy: emailBusy, run: runEmail } = useApiAction()
const { busy: passwordBusy, run: runPassword } = useApiAction()

// Both fields are edits of an existing value, not blank entries — and a
// half-typed password must not still be sitting here the next time this opens.
watch(open, (value) => {
  if (!value) return
  name.value = user.value?.name ?? ''
  email.value = user.value?.email ?? ''
  emailPassword.value = ''
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  mismatch.value = ''
})

const nameChanged = computed(() => {
  const next = name.value.trim()
  return Boolean(next) && next !== (user.value?.name ?? '')
})

const emailChanged = computed(() => {
  const next = email.value.trim().toLowerCase()
  return Boolean(next) && next !== (user.value?.email ?? '').toLowerCase()
})

/**
 * Your name and address appear on pages that fetched them separately — the
 * organization roster reads `/api/org`, not the session — so refreshing the
 * session alone leaves the page you are standing on showing the old value, which
 * reads as the change not having taken.
 */
async function refreshEverything() {
  await refresh()
  await refreshNuxtData()
}

/**
 * The credential routes report whether they managed to hand back a working
 * cookie. They answer 200 either way, because by then the change is committed and
 * failing the request would report "nothing happened" about something that did —
 * so the honest thing left to do is say so and send them to sign in again.
 */
async function settleSession(reauthenticated: boolean, changed: string): Promise<boolean> {
  if (reauthenticated) return true
  toast.warning(`${changed} Your session ended — please sign in again.`)
  await navigateTo('/login')
  return false
}

async function submitName() {
  if (!nameChanged.value) return

  await runName(async () => {
    await $fetch('/api/auth/profile', { method: 'PATCH', body: { name: name.value.trim() } })
    await refreshEverything()
  }, { success: 'Display name updated.', failure: 'Could not change the display name' })
}

async function submitEmail() {
  if (!emailChanged.value || !emailPassword.value) return

  const result = await runEmail(async () => {
    return await $fetch<{ email: string, reauthenticated: boolean }>('/api/auth/email', {
      method: 'PATCH',
      body: { email: email.value.trim(), currentPassword: emailPassword.value },
    })
  }, { failure: 'Could not change the email address' })

  if (!result) return
  if (!await settleSession(result.reauthenticated, 'Email address changed.')) return

  emailPassword.value = ''
  await refreshEverything()
  toast.success(`Email address changed to ${result.email}.`)
}

async function submitPassword() {
  mismatch.value = ''
  if (!currentPassword.value || !newPassword.value) return
  if (newPassword.value !== confirmPassword.value) {
    // Never sent: the confirmation box is a typo guard here, and the server is
    // given one password rather than being asked to trust a comparison.
    mismatch.value = 'The two new passwords do not match.'
    return
  }

  const result = await runPassword(async () => {
    return await $fetch<{ reauthenticated: boolean }>('/api/auth/password', {
      method: 'PATCH',
      body: { currentPassword: currentPassword.value, password: newPassword.value },
    })
  }, { failure: 'Could not change the password' })

  if (!result) return
  if (!await settleSession(result.reauthenticated, 'Password changed.')) return

  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  toast.success('Password changed.')
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogScrollContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Profile</DialogTitle>
        <DialogDescription>
          Your account. Changing the email address or the password asks for your
          current password.
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" @submit.prevent="submitName">
        <h3 class="text-sm font-medium">
          Display name
        </h3>

        <div class="space-y-2">
          <Label for="profile-name">Name</Label>
          <Input
            id="profile-name"
            v-model="name"
            autocomplete="name"
            maxlength="100"
            :disabled="nameBusy"
          />
          <p class="text-xs text-muted-foreground">
            How colleagues see you on the organization page.
          </p>
        </div>
        <div class="flex justify-end">
          <Button type="submit" size="sm" :disabled="nameBusy || !nameChanged">
            {{ nameBusy ? 'Saving…' : 'Save' }}
          </Button>
        </div>
      </form>

      <Separator />

      <form class="space-y-4" @submit.prevent="submitEmail">
        <h3 class="text-sm font-medium">
          Email address
        </h3>

        <div class="space-y-2">
          <Label for="profile-email">New address</Label>
          <Input
            id="profile-email"
            v-model="email"
            type="email"
            autocomplete="email"
            required
            :disabled="emailBusy"
          />
          <p class="text-xs text-muted-foreground">
            You sign in with this. A pending invitation sent to your old address
            will no longer be yours to accept.
          </p>
        </div>

        <div class="space-y-2">
          <Label for="profile-email-password">Current password</Label>
          <Input
            id="profile-email-password"
            v-model="emailPassword"
            type="password"
            autocomplete="current-password"
            required
            :disabled="emailBusy"
          />
        </div>

        <div class="flex justify-end">
          <Button
            type="submit"
            size="sm"
            :disabled="emailBusy || !emailChanged || !emailPassword"
          >
            {{ emailBusy ? 'Changing…' : 'Change email' }}
          </Button>
        </div>
      </form>

      <Separator />

      <form class="space-y-4" @submit.prevent="submitPassword">
        <h3 class="text-sm font-medium">
          Password
        </h3>

        <div class="space-y-2">
          <Label for="profile-current-password">Current password</Label>
          <Input
            id="profile-current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            :disabled="passwordBusy"
          />
        </div>

        <div class="space-y-2">
          <Label for="profile-new-password">New password</Label>
          <Input
            id="profile-new-password"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            minlength="8"
            required
            :disabled="passwordBusy"
          />
          <p class="text-xs text-muted-foreground">
            At least 8 characters. Connector tokens are not affected — rotate a
            leaked token from its connection's page.
          </p>
        </div>

        <div class="space-y-2">
          <Label for="profile-confirm-password">Confirm new password</Label>
          <Input
            id="profile-confirm-password"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            required
            :disabled="passwordBusy"
          />
          <p v-if="mismatch" class="text-xs text-destructive">
            {{ mismatch }}
          </p>
        </div>

        <div class="flex justify-end">
          <Button
            type="submit"
            size="sm"
            :disabled="passwordBusy || !currentPassword || !newPassword || !confirmPassword"
          >
            {{ passwordBusy ? 'Changing…' : 'Change password' }}
          </Button>
        </div>
      </form>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          :disabled="nameBusy || emailBusy || passwordBusy"
          @click="open = false"
        >
          Close
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
