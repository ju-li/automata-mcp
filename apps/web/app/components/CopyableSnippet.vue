<script setup lang="ts">
import { CheckIcon, CopyIcon } from '@lucide/vue'

const props = withDefaults(defineProps<{
  value: string
  ariaLabel?: string
  /**
   * A masked value is not worth copying — hiding the button is clearer than
   * handing someone a URL full of bullets that fails silently in their client.
   */
  copyable?: boolean
  /** Wrap instead of truncating — for values too long to read in one line. */
  wrap?: boolean
}>(), { copyable: true, wrap: false })

const copied = ref(false)

async function copy() {
  if (!props.value) return
  await navigator.clipboard.writeText(props.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}
</script>

<template>
  <div class="flex min-w-0 gap-2" :class="wrap ? 'items-start' : 'items-center'">
    <code
      class="block min-w-0 flex-1 select-all rounded-md bg-muted px-3 py-2 font-mono text-sm"
      :class="wrap ? 'break-all' : 'truncate'"
    >{{ value }}</code>
    <Button
      v-if="copyable"
      variant="outline"
      size="icon"
      class="shrink-0"
      :aria-label="ariaLabel || 'Copy'"
      @click="copy"
    >
      <CheckIcon v-if="copied" class="size-4" />
      <CopyIcon v-else class="size-4" />
    </Button>
  </div>
</template>
