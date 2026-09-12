<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * The page behind an invitation link.
 *
 * Reachable signed out — the whole point is that the recipient may not have an
 * account. Three states, and they are genuinely different things rather than
 * variations on a form:
 *
 *   not signed in       sign up, with the email pinned to what the invitation
 *                       names. That path creates no personal organization —
 *                       otherwise every invited signup would make one and delete
 *                       it again one request later.
 *   signed in, matches  one button.
 *   signed in as someone else
 *                       say so, and offer to sign out. Pressing Accept would
 *                       fail with a 403, so do not offer it.
 */
const route = useRoute()
const code = computed(() => String(route.params.code ?? ''))

const { user, refresh: refreshSession, logout } = useSession()

interface InvitePreview {
  ok: boolean
  reason?: string
  message?: string
  org?: { name: string }
  email?: string
  role?: OrgRole
  signedInAs?: string
  emailMatches?: boolean
}

const { data, status } = await useFetch<InvitePreview>(() => `/api/invites/${code.value}`)

const password = ref('')
const name = ref('')
const { busy, run } = useApiAction()

const signedIn = computed(() => Boolean(user.value))
const wrongAccount = computed(() => signedIn.value && data.value?.emailMatches === false)

async function accept() {
  await run(async () => {
    await $fetch(`/api/invites/${code.value}/accept`, { method: 'POST' })
    await refreshSession()
    await navigateTo('/instances')
  }, { failure: 'Could not accept the invitation', keepBusyOnSuccess: true })
}

async function signUpAndAccept() {
  await run(async () => {
    await $fetch('/api/auth/signup', {
      method: 'POST',
      body: {
        email: data.value?.email,
        password: password.value,
        name: name.value.trim() || undefined,
        invite: code.value,
      },
    })
    await refreshSession()
    toast.success(`Welcome to ${data.value?.org?.name}.`)
    await navigateTo('/instances')
  }, { failure: 'Could not create the account', keepBusyOnSuccess: true })
}
</script>

<template>
  <div class="mx-auto max-w-md py-10">
    <Skeleton v-if="status === 'pending'" class="h-64" />

    <Card v-else-if="!data?.ok">
      <CardHeader>
        <CardTitle>Invitation not usable</CardTitle>
        <CardDescription>{{ data?.message }}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button as-child variant="outline" size="sm">
          <NuxtLink to="/login">
            Go to sign in
          </NuxtLink>
        </Button>
      </CardFooter>
    </Card>

    <Card v-else>
      <CardHeader>
        <CardTitle>Join {{ data.org?.name }}</CardTitle>
        <CardDescription>
          You have been invited to join as
          {{ data.role === 'admin' ? 'an admin' : 'a member' }},
          as {{ data.email }}.
        </CardDescription>
      </CardHeader>

      <CardContent class="space-y-4">
        <p v-if="data.role" class="text-sm text-muted-foreground">
          {{ describeRoleCapabilities(data.role) }}
        </p>

        <!-- Signed in as the wrong account. Accept would 403, so do not offer it. -->
        <div v-if="wrongAccount" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p class="font-medium text-destructive">
            Signed in as {{ data.signedInAs }}
          </p>
          <p class="mt-1 text-muted-foreground">
            This invitation is for {{ data.email }}. Sign out and sign in as that
            address to accept it.
          </p>
        </div>

        <!-- Signed in as the invited address. -->
        <p v-else-if="signedIn" class="text-sm text-muted-foreground">
          Accepting moves this account into {{ data.org?.name }}.
        </p>

        <!-- Not signed in: create the account, with the email pinned. -->
        <form v-else class="space-y-4" @submit.prevent="signUpAndAccept()">
          <div class="space-y-2">
            <Label for="invite-signup-email">Email</Label>
            <!-- readonly, not disabled: this is the address the invitation is
                 bound to and it must read as a value, not as greyed-out
                 placeholder text. It cannot be changed — acceptance checks it
                 server-side against the invitation. -->
            <Input id="invite-signup-email" :model-value="data.email" type="email" readonly />
          </div>

          <div class="space-y-2">
            <Label for="invite-signup-name">Name</Label>
            <Input id="invite-signup-name" v-model="name" autocomplete="name" placeholder="Optional" />
          </div>

          <div class="space-y-2">
            <Label for="invite-signup-password">Password</Label>
            <Input
              id="invite-signup-password"
              v-model="password"
              type="password"
              required
              minlength="8"
              autocomplete="new-password"
            />
          </div>

          <Button type="submit" class="w-full" :disabled="busy || password.length < 8">
            Create account and join
          </Button>

          <p class="text-center text-sm text-muted-foreground">
            Already have an account?
            <NuxtLink class="underline" to="/login">
              Sign in
            </NuxtLink>
            first, then open this link again.
          </p>
        </form>
      </CardContent>

      <CardFooter v-if="signedIn" class="gap-2">
        <Button v-if="!wrongAccount" :disabled="busy" @click="accept()">
          Accept invitation
        </Button>
        <Button variant="outline" :disabled="busy" @click="logout()">
          Sign out
        </Button>
      </CardFooter>
    </Card>
  </div>
</template>
