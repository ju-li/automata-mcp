<script setup lang="ts">
import { LogOutIcon, UsersIcon } from '@lucide/vue'

const { user, org, logout } = useSession()
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header v-if="user" class="border-b">
      <div class="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-6">
        <div class="flex min-w-0 items-center gap-3">
          <NuxtLink to="/instances">
            <AppLogo />
          </NuxtLink>
          <!-- Which organization you are acting in. Everything on every page
               belongs to it, and with one organization per account there is no
               switcher — this is a label, not a control. -->
          <span v-if="org" class="hidden truncate border-l pl-3 text-sm text-muted-foreground sm:inline">
            {{ org.name }}
          </span>
        </div>

        <div class="flex items-center gap-3">
          <Button v-if="org" as-child variant="ghost" size="sm">
            <NuxtLink to="/team">
              <UsersIcon class="size-4" />
              <span class="hidden sm:inline">Organization</span>
            </NuxtLink>
          </Button>
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
