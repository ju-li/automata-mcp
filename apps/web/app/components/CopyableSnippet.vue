<script setup lang="ts">
import { CheckIcon, CopyIcon, TriangleAlertIcon } from '@lucide/vue'

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

/**
 * What the last click did.
 *
 * `failed` is not an edge case to swallow. `RevealTokenDialog` copies a token
 * through this that is shown exactly once and stored only as a hash, so a click
 * that silently did nothing lets someone close the dialog believing they have
 * it — and the only recovery is minting a new one.
 */
const status = ref<'idle' | 'copied' | 'failed'>('idle')
const snippet = ref<HTMLElement | null>(null)
let reset: ReturnType<typeof setTimeout> | undefined

// A new value is a new thing to copy; an old failure says nothing about it.
watch(() => props.value, () => {
  clearTimeout(reset)
  status.value = 'idle'
})

onBeforeUnmount(() => clearTimeout(reset))

async function copy() {
  if (!props.value) return
  clearTimeout(reset)

  try {
    // Two ways this fails, and both land in the catch. A denied permission
    // rejects. A non-secure origin — the dev server opened by LAN IP, which
    // `nuxt dev --host 0.0.0.0` invites — has no `navigator.clipboard` at all,
    // so reading `writeText` off it throws inside this async function instead.
    await navigator.clipboard.writeText(props.value)
    status.value = 'copied'
    reset = setTimeout(() => (status.value = 'idle'), 2000)
  }
  catch {
    status.value = 'failed'
    selectSnippet()
  }
}

/** Leave the value selected, so the fallback is one keystroke rather than a drag. */
function selectSnippet() {
  const selection = window.getSelection()
  if (!snippet.value || !selection) return
  const range = document.createRange()
  range.selectNodeContents(snippet.value)
  selection.removeAllRanges()
  selection.addRange(range)
}
</script>

<template>
  <div class="min-w-0 space-y-1.5">
    <div class="flex min-w-0 gap-2" :class="wrap ? 'items-start' : 'items-center'">
      <code
        ref="snippet"
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
        <CheckIcon v-if="status === 'copied'" class="size-4" />
        <TriangleAlertIcon v-else-if="status === 'failed'" class="size-4 text-destructive" />
        <CopyIcon v-else class="size-4" />
      </Button>
    </div>

    <!-- role="alert" so a screen reader hears the failure the icon only shows. -->
    <p v-if="status === 'failed'" role="alert" class="text-xs text-destructive">
      Could not copy automatically. It is selected above — press Ctrl+C (⌘C on a Mac) to copy it.
    </p>
  </div>
</template>
