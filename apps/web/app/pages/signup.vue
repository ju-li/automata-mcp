<script setup lang="ts">
const { refresh } = useSession()

const email = ref('')
const password = ref('')
const signupCode = ref('')
const error = ref('')
const busy = ref(false)

// How this deployment lets people sign up without an invitation. Unknown (the
// read failed) shows the form; the server decides either way.
const { data: policy } = await useFetch<{ selfSignup: 'open' | 'code' | 'closed' }>('/api/auth/signup-policy')
const selfSignup = computed(() => policy.value?.selfSignup ?? 'open')

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/signup', {
      method: 'POST',
      body: {
        email: email.value,
        password: password.value,
        signupCode: selfSignup.value === 'code' ? signupCode.value : undefined,
      },
    })
    await refresh()
    await navigateTo('/instances')
  }
  catch (err: any) {
    error.value = apiErrorMessage(err, 'Could not create the account')
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Create an account
    </h1>
    <p v-if="selfSignup !== 'closed'" class="mt-1 text-sm text-muted-foreground">
      You will add your first connection in the next step.
    </p>

    <p v-if="selfSignup === 'closed'" class="mt-8 text-sm text-muted-foreground">
      Sign-up on this deployment is by invitation. Ask an admin of your
      organization for an invitation link.
    </p>

    <form v-else class="mt-8 space-y-4" @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input id="email" v-model="email" type="email" autocomplete="email" required />
      </div>

      <div class="space-y-2">
        <Label for="password">Password</Label>
        <Input id="password" v-model="password" type="password" autocomplete="new-password" minlength="8" required />
        <p class="text-xs text-muted-foreground">
          At least 8 characters.
        </p>
      </div>

      <div v-if="selfSignup === 'code'" class="space-y-2">
        <Label for="signup-code">Signup code</Label>
        <Input id="signup-code" v-model="signupCode" autocomplete="off" required />
        <p class="text-xs text-muted-foreground">
          This deployment needs a code to create an account. Joining an existing
          organization? Use the invitation link instead.
        </p>
      </div>

      <p v-if="error" class="text-sm text-destructive">
        {{ error }}
      </p>

      <Button type="submit" class="w-full" :disabled="busy">
        {{ busy ? 'Creating…' : 'Create account' }}
      </Button>
    </form>

    <p class="mt-6 text-center text-sm text-muted-foreground">
      Already have an account?
      <NuxtLink to="/login" class="text-foreground underline underline-offset-4">
        Sign in
      </NuxtLink>
    </p>
  </div>
</template>
