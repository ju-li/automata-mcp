<script setup lang="ts">
const { refresh } = useSession()

const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: email.value, password: password.value },
    })
    await refresh()
    await navigateTo('/instances')
  }
  catch (err: any) {
    error.value = err?.data?.statusMessage || 'Could not sign in'
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-sm py-10">
    <h1 class="font-heading text-2xl font-semibold">
      Sign in
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Connect WhatsApp to Claude.
    </p>

    <form class="mt-8 space-y-4" @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input id="email" v-model="email" type="email" autocomplete="email" required />
      </div>

      <div class="space-y-2">
        <Label for="password">Password</Label>
        <Input id="password" v-model="password" type="password" autocomplete="current-password" required />
      </div>

      <p v-if="error" class="text-sm text-destructive">
        {{ error }}
      </p>

      <Button type="submit" class="w-full" :disabled="busy">
        {{ busy ? 'Signing in…' : 'Sign in' }}
      </Button>
    </form>

    <p class="mt-6 text-center text-sm text-muted-foreground">
      No account?
      <NuxtLink to="/signup" class="text-foreground underline underline-offset-4">
        Create one
      </NuxtLink>
    </p>
  </div>
</template>
