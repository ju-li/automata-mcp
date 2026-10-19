<script setup lang="ts">
import { ChevronDownIcon, CircleUserIcon, LogOutIcon, MailIcon, UserIcon, UsersIcon } from '@lucide/vue'

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
          <Button as-child variant="ghost" size="sm">
            <a href="https://www.getautomata.app/contact" target="_blank" rel="noopener noreferrer">
              <MailIcon class="size-4" />
              <span class="hidden sm:inline">Contact</span>
            </a>
          </Button>

          <Button v-if="org" as-child variant="ghost" size="sm">
            <NuxtLink to="/team">
              <UsersIcon class="size-4" />
              <span class="hidden sm:inline">Organization</span>
            </NuxtLink>
          </Button>

          <!-- The account menu. The icon is always there and the address is not:
               on a phone the header used to identify the signed-in account with
               nothing at all, because the email was the only marker and it was
               hidden below `sm`. The menu's own label carries it instead. -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" class="max-w-[14rem]">
                <CircleUserIcon class="size-4" />
                <span class="hidden truncate sm:inline">{{ user.email }}</span>
                <ChevronDownIcon class="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuLabel class="font-normal">
                <span v-if="user.name" class="block truncate">{{ user.name }}</span>
                <span class="block truncate text-xs font-normal text-muted-foreground">
                  {{ user.email }}
                </span>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuItem as-child>
                <NuxtLink to="/profile">
                  <UserIcon class="size-4" />
                  Profile
                </NuxtLink>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem variant="destructive" @select="logout()">
                <LogOutIcon class="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-6 py-10">
      <slot />
    </main>
  </div>
</template>
