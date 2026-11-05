<script setup lang="ts">
/**
 * A messaging account that is still linked and whose connection dropped.
 *
 * Shown to members too, without the button: they cannot reconnect, and being
 * told to would be worse than being told who can. The `#hint` slot is the
 * manager's reassurance about whether a new scan is needed, and `#stalled`
 * says what to restart when asking did not bring it back — both differ by kind.
 *
 * `canReconnect` false means pressing the button cannot help in the current
 * state — WhatsApp refuses anything but a `close` socket, see `reconnectInstance`
 * — so the restart advice in `#stalled` is shown straight away instead of a
 * button that would only answer with it.
 */
withDefaults(defineProps<{
  service: string
  canManage: boolean
  reconnecting: boolean
  stalled: boolean
  busy: boolean
  canReconnect?: boolean
}>(), { canReconnect: true })

defineEmits<{ reconnect: [] }>()
</script>

<template>
  <NoticeCard :title="`${service} dropped this account's connection`">
    <template #description>
      <p class="mt-1 text-sm text-muted-foreground">
        New messages are not arriving and nothing can be sent until it reconnects.
        <slot v-if="canManage" name="hint" />
        <template v-else>
          An admin of your organization can bring it back.
        </template>
      </p>
    </template>

    <p v-if="canManage && !reconnecting && (stalled || !canReconnect)" class="text-sm text-muted-foreground">
      <slot name="stalled" />
    </p>

    <!-- Kept while a reconnect is being watched: the socket passes through
         `connecting` on its way back, and the button vanishing then reads as
         the attempt having failed. -->
    <Button v-if="canManage && (canReconnect || reconnecting)" size="sm" :disabled="busy || reconnecting" @click="$emit('reconnect')">
      {{ reconnecting ? 'Reconnecting…' : stalled ? 'Try again' : 'Reconnect' }}
    </Button>
  </NoticeCard>
</template>
