<script setup lang="ts">
import { CheckIcon, CopyIcon } from '@lucide/vue'

/**
 * The body of an error toast: the server's own words under the toast's title,
 * the request that failed, the app's error code, and a button that copies a
 * full report (time and page included) for a bug report.
 *
 * Fixed in height on purpose. vue-sonner measures a toast once, when it
 * mounts, and stacks the next one from that number; a body that grew later (an
 * expandable Details panel was tried) spilled out of its card and pushed the
 * title off the top of the screen.
 *
 * Rendered by vue-sonner as the toast's `description`, with `details` and
 * `title` passed through `componentProps` (see `showErrorToast`). Built only from
 * `ErrorDetails`, which never holds a request body, so nothing here can show
 * or copy a password the failed request carried.
 */
const props = defineProps<{
  details: ErrorDetails
  title?: string
}>()

const copied = ref<'idle' | 'done' | 'failed'>('idle')

const showMessage = computed(() => props.details.message !== props.title)

const summary = computed(() => {
  const d = props.details
  const status = d.status ? `${d.status}${d.statusText ? ` ${d.statusText}` : ''}` : d.network ? 'No response' : undefined
  const request = d.path ? `${d.method ?? 'GET'} ${d.path}` : undefined
  return [status, request].filter(Boolean).join(' · ')
})

/** `pg_connect_failed · 28P01` — what to search the docs or logs for. */
const codes = computed(() => [props.details.code, props.details.reason].filter(Boolean).join(' · '))

async function copy() {
  try {
    await navigator.clipboard.writeText(errorDetailsText(props.details, props.title))
    copied.value = 'done'
  }
  catch {
    // A non-secure origin (the dev server by LAN IP) has no clipboard at all.
    copied.value = 'failed'
  }
  setTimeout(() => { copied.value = 'idle' }, 2000)
}
</script>

<template>
  <div class="space-y-1.5 text-xs">
    <p v-if="showMessage" class="text-sm leading-snug">
      {{ details.message }}
    </p>
    <p v-if="summary" class="font-mono opacity-80">
      {{ summary }}
    </p>

    <p v-if="codes" class="font-mono opacity-80">
      {{ codes }}
    </p>

    <button
      type="button"
      class="inline-flex items-center gap-1 pt-0.5 font-medium underline-offset-2 hover:underline"
      @click="copy"
    >
      <CheckIcon v-if="copied === 'done'" class="size-3.5" />
      <CopyIcon v-else class="size-3.5" />
      {{ copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy details' }}
    </button>
  </div>
</template>
