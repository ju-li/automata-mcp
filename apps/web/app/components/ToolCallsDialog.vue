<script setup lang="ts">
/**
 * A token's recorded tool calls, newest first, with the reason the model gave
 * for each. See server/utils/tool-calls.ts.
 *
 * Fetched when opened, a page at a time — the history can be long, and the
 * token list must not pay for it. Every reason is the model's own account,
 * rendered as text and labelled as such.
 */
const props = defineProps<{
  open: boolean
  tokenId?: string
  label?: string
}>()

defineEmits<{ 'update:open': [value: boolean] }>()

const calls = ref<ToolCall[]>([])
const hasMore = ref(false)
const page = ref(0)
const recording = ref<{ recording: boolean, required: boolean } | null>(null)
const loading = ref(false)
const failed = ref(false)
/** Bumped on every fresh open, so a page for a previous token cannot land. */
let generation = 0

async function load(next: number) {
  if (!props.tokenId) return
  const mine = generation
  loading.value = true
  failed.value = false
  try {
    const result = await $fetch<ToolCallPage>(`/api/tokens/${props.tokenId}/calls`, { query: { page: next } })
    if (mine !== generation) return
    calls.value = next === 1 ? result.calls : [...calls.value, ...result.calls]
    hasMore.value = result.hasMore
    page.value = result.page
    recording.value = result.toolCalls
  }
  catch {
    // A failed page leaves what is shown, and `hasMore`, as they were.
    if (mine === generation) failed.value = true
  }
  finally {
    if (mine === generation) loading.value = false
  }
}

watch(() => [props.open, props.tokenId] as const, ([open]) => {
  generation++
  calls.value = []
  hasMore.value = false
  page.value = 0
  recording.value = null
  failed.value = false
  if (open) load(1)
}, { immediate: true })

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
</script>

<template>
  <Dialog :open="open" @update:open="value => $emit('update:open', value)">
    <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-4xl">
      <DialogHeader class="shrink-0">
        <DialogTitle>Tool calls by “{{ label }}”</DialogTitle>
        <DialogDescription>
          The last 30 days. Each reason is Claude's own one-line account of why
          it made the call — written by the model, not by the person using it,
          and not always accurate.
        </DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="recording && !recording.recording" class="mb-4 text-sm text-muted-foreground">
          Telemetry is off for this organization, so new calls are not stored.
          An admin can turn it on under Team.
        </p>

        <p v-if="failed && !calls.length" class="text-sm text-destructive">
          Could not load the tool calls. Try again in a moment.
        </p>
        <p v-else-if="loading && !calls.length" class="text-sm text-muted-foreground">
          Loading…
        </p>
        <p v-else-if="!calls.length" class="text-sm text-muted-foreground">
          No tool calls recorded for this token in the last 30 days.
        </p>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="call in calls" :key="call.id">
              <TableCell class="align-top whitespace-nowrap text-muted-foreground">
                {{ formatDateTime(call.at) }}
              </TableCell>
              <TableCell class="align-top">
                <div class="flex flex-wrap items-center gap-2 font-mono text-xs">
                  {{ call.tool }}
                  <Badge v-if="!call.ok" variant="destructive">
                    Failed
                  </Badge>
                </div>
              </TableCell>
              <TableCell class="max-w-md align-top whitespace-normal">
                <span v-if="call.reason" class="[overflow-wrap:anywhere]">{{ call.reason }}</span>
                <span v-else class="text-muted-foreground italic">No reason given</span>
                <div v-if="call.userAgent" class="mt-0.5 text-xs break-all text-muted-foreground">
                  {{ call.userAgent }}
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <p v-if="failed && calls.length" class="mt-4 text-sm text-destructive">
          Could not load more. Try again in a moment.
        </p>
      </div>

      <DialogFooter class="shrink-0">
        <Button v-if="hasMore" variant="outline" :disabled="loading" @click="load(page + 1)">
          Load more
        </Button>
        <Button variant="ghost" @click="$emit('update:open', false)">
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
