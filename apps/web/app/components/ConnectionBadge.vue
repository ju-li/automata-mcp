<script setup lang="ts">
const props = defineProps<{ state: ConnectionState }>()
const display = computed(() => describeState(props.state))
</script>

<template>
  <Badge :variant="display.variant">
    {{ display.label }}
  </Badge>
</template>
