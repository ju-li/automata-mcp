<script setup lang="ts">
// The gate in middleware/auth.global.ts has already established a session by the
// time this renders.
await navigateTo('/instances', { replace: true })
</script>

<template>
  <div />
</template>
