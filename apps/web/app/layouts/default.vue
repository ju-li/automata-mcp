<script setup lang="ts">
import { ChevronDownIcon, CircleUserIcon, LogOutIcon, UserIcon, UsersIcon } from '@lucide/vue'

const { user, org, logout } = useSession()

const profileOpen = ref(false)

/**
 * Set only while a menu item is handing off to the dialog.
 *
 * reka-ui closes the menu *after* the `select` handler runs (`Menu/MenuItem.js`:
 * emit, `nextTick`, `rootContext.onClose()`), and the closing `FocusScope` then
 * restores focus to the trigger — one tick after the dialog mounted and focused
 * its first field, so the dialog opens with focus sitting on the header button
 * behind it. Suppressing that restore unconditionally would be wrong: a keyboard
 * user who merely dismisses the menu with Escape should get focus back. Hence a
 * flag, cleared as it is used.
 *
 * What is deliberately NOT done: `event.preventDefault()` on `select`, which keeps
 * the menu *open*. An open reka menu is a modal layer — it aria-hides the rest of
 * the document and disables outside pointer events — so the dialog would render
 * underneath something actively fighting it.
 */
let handingOff = false

function openProfile() {
  handingOff = true
  profileOpen.value = true
}

function onMenuCloseAutoFocus(event: Event) {
  if (!handingOff) return
  handingOff = false
  event.preventDefault()
}

/**
 * The dialog is opened from a menu item that no longer exists by the time it
 * closes, so there is nothing for its own focus restore to return to and focus
 * lands on `<body>` — a keyboard user then tabs from the top of the document.
 * Hand it back to the control that started all this.
 */
const accountTrigger = useTemplateRef<{ $el?: HTMLElement }>('accountTrigger')

watch(profileOpen, async (value) => {
  if (value) return
  await nextTick()
  accountTrigger.value?.$el?.focus?.()
})
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

          <!-- The account menu. The icon is always there and the address is not:
               on a phone the header used to identify the signed-in account with
               nothing at all, because the email was the only marker and it was
               hidden below `sm`. The menu's own label carries it instead. -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button ref="accountTrigger" variant="ghost" size="sm" class="max-w-[14rem]">
                <CircleUserIcon class="size-4" />
                <span class="hidden truncate sm:inline">{{ user.email }}</span>
                <ChevronDownIcon class="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" class="w-56" @close-auto-focus="onMenuCloseAutoFocus">
              <DropdownMenuLabel class="font-normal">
                <span v-if="user.name" class="block truncate">{{ user.name }}</span>
                <span class="block truncate text-xs font-normal text-muted-foreground">
                  {{ user.email }}
                </span>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuItem @select="openProfile()">
                <UserIcon class="size-4" />
                Profile
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

    <!-- A sibling of the menu, never inside `DropdownMenuContent`: a dialog
         mounted in there unmounts the moment the menu closes. -->
    <ProfileDialog v-if="user" v-model:open="profileOpen" />

    <main class="mx-auto max-w-5xl px-6 py-10">
      <slot />
    </main>
  </div>
</template>
