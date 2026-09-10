<script setup lang="ts">
const props = defineProps<{ state: ConnectionState, kind?: InstanceKind }>()
// Without the kind, a database that is down renders "Disconnected — not paired
// with a phone", which is the wrong diagnosis for the wrong device.
const display = computed(() => describeState(props.state, props.kind))
</script>

<template>
  <Badge :variant="display.variant">
    {{ display.label }}
  </Badge>
</template>
