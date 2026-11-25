<script setup lang="ts">
// The promotion banner, top of every page while a promotion runs.
//
// What it says comes from `NUXT_PROMO` (server/utils/promo.ts), and whether it
// shows at all is the server's call: `/api/auth/me` sends `promo` only on the
// hosted offering, only to organizations on Free, and only until its end date.
// Nothing here re-decides that. Hidden on the first-run setup (/welcome), a
// guided flow, not a page to sell on.
//
// The code is a Stripe promotion code typed on the Checkout page. Only admins
// can reach Billing; members are told to ask one.
const route = useRoute()
const { user, isAdmin } = useSession()
const { promo } = usePlan()

const visible = computed(() => Boolean(user.value && promo.value) && !route.path.startsWith('/welcome'))
</script>

<template>
  <div v-if="visible && promo" class="bg-primary text-primary-foreground">
    <p class="mx-auto max-w-5xl px-6 py-2 text-center text-sm">
      {{ promo.holiday }} offer: {{ promo.details }} with code
      <code class="rounded bg-primary-foreground/10 px-1.5 py-0.5 font-mono font-semibold">{{ promo.code }}</code>.
      <NuxtLink v-if="isAdmin" to="/billing" class="font-medium underline underline-offset-4">
        Upgrade to Pro
      </NuxtLink>
      <template v-else>
        Ask an admin to upgrade.
      </template>
    </p>
  </div>
</template>
