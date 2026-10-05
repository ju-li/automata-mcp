<script setup lang="ts">
/**
 * A callout that something about this connection needs attention: amber for
 * "works, but not fully", red for "could not be reached at all".
 */
const props = withDefaults(defineProps<{
  title: string
  tone?: 'warning' | 'error'
}>(), { tone: 'warning' })
</script>

<template>
  <div
    class="space-y-3 rounded-md border p-4"
    :class="props.tone === 'error' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'"
  >
    <div>
      <p class="text-sm font-medium">
        {{ props.title }}
      </p>
      <slot name="description" />
    </div>
    <slot />
  </div>
</template>
