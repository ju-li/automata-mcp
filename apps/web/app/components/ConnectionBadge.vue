<script setup lang="ts">
const props = defineProps<{ state: ConnectionState, kind: InstanceKind, lost?: boolean, flapping?: boolean }>()
// Without the kind, a database that is down renders "Disconnected — not paired
// with a phone", which is the wrong diagnosis for the wrong device. Without
// `lost`, a WhatsApp session that dropped renders the same wrong diagnosis;
// without `flapping`, a reconnect loop renders "Connected".
const display = computed(() => describeState(props.state, props.kind, { lost: props.lost, flapping: props.flapping }))
</script>

<template>
  <Badge :variant="display.variant">
    {{ display.label }}
  </Badge>
</template>
