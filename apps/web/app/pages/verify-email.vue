<script setup lang="ts">
import { toast } from 'vue-sonner'

/**
 * Proving an email address: after signing up, or after asking to change the
 * address on the profile page. See server/utils/email-verification.ts.
 *
 * Two ways in, and they need different things:
 *
 *   ?token=…   the link from the mail. Needs no cookie, so it works on another
 *              device. Spent only by the Confirm button, never on load — mail
 *              scanners open links, and opening one must not use it up.
 *   no token   the browser that started it, waiting for the six-digit code.
 *              The pending row is named by an httpOnly cookie, so what is
 *              pending is asked of the server rather than carried in the URL.
 *
 * Reachable signed in, signed out and without an organization: a signup is
 * signed out until this succeeds, and an address change is signed in.
 */
const route = useRoute()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')

const { refresh } = useSession()

interface Pending { purpose: 'signup' | 'email_change', email: string }

const { data, status, refresh: refreshPending } = await useFetch<{ pending: Pending | null }>(
  '/api/auth/verify',
  // Client only: the cookie is scoped to /api/auth/verify, so the browser never
  // sends it with this page's own request and a server-side fetch would always
  // answer "nothing pending".
  { immediate: !token.value, server: false },
)
const pending = computed(() => data.value?.pending ?? null)

const code = ref('')
const { busy, run } = useApiAction()
const { busy: resendBusy, run: runResend } = useApiAction()

async function finished(result: { purpose: Pending['purpose'], email: string }) {
  await refresh()
  if (result.purpose === 'signup') {
    toast.success('Email confirmed. Welcome!')
    await navigateTo('/instances')
  }
  else {
    toast.success(`Your sign-in address is now ${result.email}.`)
    await refreshNuxtData()
    await navigateTo('/profile')
  }
}

async function submitCode() {
  const result = await run(async () => {
    return await $fetch<{ purpose: Pending['purpose'], email: string }>('/api/auth/verify', {
      method: 'POST',
      body: { code: code.value.trim() },
    })
  }, { failure: 'Could not verify the code', keepBusyOnSuccess: true })

  if (result) await finished(result)
  else {
    code.value = ''
    // A fifth wrong code deletes the pending row; ask again so the page says so.
    await refreshPending()
  }
}

async function confirmLink() {
  const result = await run(async () => {
    return await $fetch<{ purpose: Pending['purpose'], email: string }>('/api/auth/verify/link', {
      method: 'POST',
      body: { token: token.value },
    })
  }, { failure: 'Could not confirm the email address', keepBusyOnSuccess: true })

  if (result) await finished(result)
}

async function resend() {
  await runResend(async () => {
    await $fetch('/api/auth/verify/resend', { method: 'POST' })
  }, { success: 'A new code is on its way. The previous one no longer works.', failure: 'Could not send a new code' })
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Confirm your email
    </h1>

    <!-- The mailed link. -->
    <div v-if="token" class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        Press confirm to prove this address is yours.
      </p>
      <Button class="w-full" :disabled="busy" @click="confirmLink()">
        {{ busy ? 'Confirming…' : 'Confirm email address' }}
      </Button>
    </div>

    <Skeleton v-else-if="status === 'idle' || status === 'pending'" class="mt-8 h-40" />

    <!-- Waiting for the code. -->
    <form v-else-if="pending" class="mt-8 space-y-4" @submit.prevent="submitCode">
      <p class="text-sm text-muted-foreground">
        We sent a six-digit code to <span class="font-medium text-foreground">{{ pending.email }}</span>.
        Enter it here, or open the link in that email. It expires in 30 minutes.
      </p>

      <div class="space-y-2">
        <Label for="verify-code">Code</Label>
        <Input
          id="verify-code"
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          pattern="\d{6}"
          required
          :disabled="busy"
        />
      </div>

      <Button type="submit" class="w-full" :disabled="busy || code.trim().length !== 6">
        {{ busy ? 'Checking…' : 'Verify' }}
      </Button>

      <p class="text-center text-sm text-muted-foreground">
        Nothing arrived?
        <button
          type="button"
          class="text-foreground underline underline-offset-4 disabled:opacity-50"
          :disabled="resendBusy"
          @click="resend()"
        >
          Send a new code
        </button>
      </p>
    </form>

    <div v-else class="mt-8 space-y-4">
      <p class="text-sm text-muted-foreground">
        There is nothing waiting to be confirmed in this browser. The code may have
        expired or been used, or you started in another browser — open the link
        from the email there instead.
      </p>
      <div class="flex gap-2">
        <Button as-child variant="outline">
          <NuxtLink to="/signup">
            Sign up again
          </NuxtLink>
        </Button>
        <Button as-child variant="outline">
          <NuxtLink to="/login">
            Sign in
          </NuxtLink>
        </Button>
      </div>
    </div>
  </div>
</template>
