<script setup lang="ts">
import { ChevronLeftIcon, ChevronRightIcon } from '@lucide/vue'

/**
 * Previous/next across a server-paged table, and the count in words.
 *
 * `total` is optional because a page past the end of a range carries no count —
 * "I did not measure" and "there are none" are different answers, and the last
 * page count is the one place that distinction shows up. With no total the
 * control falls back to `hasMore` alone rather than inventing a page count.
 *
 * Hand-written rather than shadcn's `pagination`: this shows a range and two
 * buttons, not a numbered strip, and it is built from `Button`, which carries
 * the focus and disabled styling anyway.
 */
const props = defineProps<{
  page: number
  pageSize: number
  rowCount: number
  total?: number
  hasMore: boolean
  loading?: boolean
  /** What the rows are, for the summary line: "chats", "messages", "contacts". */
  noun: string
}>()

const emit = defineEmits<{ 'update:page': [number] }>()

const format = new Intl.NumberFormat()

const first = computed(() => (props.page - 1) * props.pageSize + 1)
const last = computed(() => (props.page - 1) * props.pageSize + props.rowCount)

const pages = computed(() =>
  props.total === undefined ? undefined : Math.max(1, Math.ceil(props.total / props.pageSize)),
)
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-xs text-muted-foreground tabular-nums">
      <template v-if="loading">
        Loading…
      </template>
      <template v-else-if="!rowCount">
        No {{ noun }} to show.
      </template>
      <template v-else-if="total !== undefined">
        Showing {{ format.format(first) }}–{{ format.format(last) }} of
        {{ format.format(total) }} {{ noun }}.
      </template>
      <template v-else>
        Showing {{ format.format(first) }}–{{ format.format(last) }}.
      </template>
    </p>

    <div class="flex shrink-0 items-center gap-2">
      <span v-if="pages !== undefined" class="text-xs text-muted-foreground tabular-nums">
        Page {{ format.format(page) }} of {{ format.format(pages) }}
      </span>
      <Button
        variant="outline"
        size="icon"
        class="size-8"
        aria-label="Previous page"
        :disabled="page <= 1 || loading"
        @click="emit('update:page', page - 1)"
      >
        <ChevronLeftIcon class="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        class="size-8"
        aria-label="Next page"
        :disabled="!hasMore || loading"
        @click="emit('update:page', page + 1)"
      >
        <ChevronRightIcon class="size-4" />
      </Button>
    </div>
  </div>
</template>
