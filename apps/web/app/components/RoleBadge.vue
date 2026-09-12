<script setup lang="ts">
defineProps<{ role: OrgRole }>()
</script>

<template>
  <Badge :variant="role === 'admin' ? 'default' : 'secondary'">
    {{ describeRole(role) }}
  </Badge>
</template>
