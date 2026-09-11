<script setup lang="ts">
import { LogOutIcon } from '@lucide/vue'

const { user, logout } = useSession()
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header v-if="user" class="border-b">
      <div class="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-6">
        <NuxtLink to="/instances">
          <AppLogo />
        </NuxtLink>

        <div class="flex items-center gap-3">
          <span class="hidden text-sm text-muted-foreground sm:inline">{{ user.email }}</span>
          <Button variant="ghost" size="sm" @click="logout()">
            <LogOutIcon class="size-4" />
            Sign out
          </Button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-6 py-10">
      <slot />
    </main>
  </div>
</template>
