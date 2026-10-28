<script setup lang="ts">
// The hosted offering's terms and privacy policy, linked from the footer and
// from every form that creates an account. They govern the hosted service
// only, so a self-hosted deployment shows neither.
defineProps<{ agreement?: boolean }>()

const hosted = useHosted()
</script>

<template>
  <template v-if="hosted">
    <p v-if="agreement" class="text-center text-xs text-muted-foreground">
      By creating an account, you agree to the
      <a href="https://www.getautomata.app/terms" target="_blank" rel="noopener noreferrer" class="underline underline-offset-4 hover:text-foreground">Terms of Service</a>
      and
      <a href="https://www.getautomata.app/privacy" target="_blank" rel="noopener noreferrer" class="underline underline-offset-4 hover:text-foreground">Privacy Policy</a>.
    </p>
    <nav v-else class="flex items-center gap-4 text-xs text-muted-foreground">
      <a href="https://www.getautomata.app/privacy" target="_blank" rel="noopener noreferrer" class="hover:text-foreground">Privacy</a>
      <a href="https://www.getautomata.app/terms" target="_blank" rel="noopener noreferrer" class="hover:text-foreground">Terms</a>
    </nav>
  </template>
</template>
