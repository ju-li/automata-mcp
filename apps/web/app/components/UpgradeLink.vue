<script setup lang="ts">
// "Upgrade" to the Billing page, then the slot saying what upgrading buys.
// Renders nothing where there is no billing (self-hosted), and nothing for a
// member: Billing is an admin's page, and a member who created a connection
// sees the same plan notes an admin does — a link they cannot follow is worse
// than none.
const { billing } = usePlan()
const { isAdmin } = useSession()
</script>

<template>
  <template v-if="billing && isAdmin">
    <NuxtLink to="/billing" class="underline underline-offset-2">
      Upgrade
    </NuxtLink>
    <slot />
  </template>
</template>
