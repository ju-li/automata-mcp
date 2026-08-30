<script setup lang="ts">
import { ArrowUpDownIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon, UserIcon, UsersIcon } from '@lucide/vue'

/**
 * Every conversation on the account, as a table.
 *
 * Opened from the dashboard's "Chats" stat card. The two numbers do not measure
 * the same thing and must not be subtracted from one another: the card is
 * Evolution's `_count.Chat`, rows in its `Chat` table, while this list is
 * `DISTINCT ON (remoteJid)` over `"Message"`. History sync records a chat for
 * every conversation the phone lists but keeps only the messages it was actually
 * sent, so a shortfall here is usually conversations with nothing stored to show
 * — not a page boundary. `hasMore` from the endpoint is the only thing that says
 * whether another page exists.
 */
const props = defineProps<{
  instanceId: string
  open: boolean
  /** The dashboard's chat count. Explains a shortfall; never decides whether to fetch. */
  total?: number
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

/**
 * One page, big. Each request re-reads Evolution's whole contact table to name
 * the rows, so the cost is per page rather than per row and a second page is a
 * genuine expense — hence a large `take` and an explicit button rather than
 * paging on scroll.
 */
const TAKE = 2000

interface ChatPageResponse {
  chats: ScopedChat[]
  hasMore: boolean
}

/**
 * Pages accumulate here rather than in a `useFetch` binding: a reactive URL
 * *replaces* `data`, and appending is the whole point. Same accumulator shape the
 * scope picker uses for hand-added numbers.
 */
const rows = ref<ScopedChat[]>([])
const hasMore = ref(false)
/**
 * Offset for the next request: rows Evolution has handed over, not rows kept.
 * The dedupe below can drop one, and paging from the kept count would walk
 * backwards over ground already covered.
 */
const nextSkip = ref(0)
/**
 * Which open the in-flight request belongs to. Closing and reopening resets the
 * accumulator, and a page still in flight from the previous open would otherwise
 * land in it and set `hasMore` and `nextSkip` from a run that no longer exists.
 */
const generation = ref(0)
const loadingFirst = ref(true)
const loadingMore = ref(false)
const loadFailed = ref(false)

/**
 * Deliberately deferred, for the same reason as the token scope picker: this call
 * can spend eight seconds inside Evolution's group lookup, and awaiting it in
 * setup would hold the whole dialog off the screen — which reads as a click that
 * did nothing. Nothing is fetched until the dialog is actually opened.
 */
async function loadPage(skip: number) {
  const mine = generation.value
  loadFailed.value = false
  if (skip === 0) loadingFirst.value = true
  else loadingMore.value = true

  try {
    const page = await $fetch<ChatPageResponse>(
      `/api/instances/${props.instanceId}/chats`,
      { query: { take: TAKE, skip } },
    )

    if (mine !== generation.value) return

    // Deduped by JID: Evolution orders this listing by last activity, so a
    // message arriving between two requests shifts a row across the offset and
    // the same chat comes back twice.
    const byJid = new Map(rows.value.map(chat => [chat.jid, chat]))
    for (const chat of page.chats) byJid.set(chat.jid, chat)

    rows.value = [...byJid.values()]
    hasMore.value = page.hasMore
    nextSkip.value = skip + page.chats.length
  }
  catch (error) {
    if (mine !== generation.value) return
    console.error('[chats] could not load page:', error)
    // Leave `hasMore` alone. A failed page that clears it would read as the end
    // of the list, which is the one thing this must never claim wrongly.
    loadFailed.value = true
  }
  finally {
    if (mine === generation.value) {
      loadingFirst.value = false
      loadingMore.value = false
    }
  }
}

const loading = computed(() => loadingFirst.value)
const chats = computed(() => rows.value)

/**
 * The list is short and there is no next page — so the missing conversations are
 * ones Evolution cannot list, not ones behind an offset.
 */
const unlistable = computed(() =>
  !hasMore.value && chats.value.length < (props.total ?? 0),
)

// ── search ─────────────────────────────────────────────────────────────────
const search = ref('')

watch(() => props.open, (open) => {
  if (!open) return
  search.value = ''
  generation.value++
  rows.value = []
  hasMore.value = false
  nextSkip.value = 0
  loadFailed.value = false
  loadPage(0)
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return chats.value
  return chats.value.filter(c =>
    c.name.toLowerCase().includes(q)
    || c.jid.toLowerCase().includes(q)
    || (c.number?.includes(q) ?? false),
  )
})

// ── sorting ────────────────────────────────────────────────────────────────
// Sorted here rather than trusted from the server: Evolution decides the order of
// its own listing and nothing downstream re-sorts it.
type SortKey = 'name' | 'number' | 'type' | 'last'

const sortKey = ref<SortKey>('last')
const sortDir = ref<'asc' | 'desc'>('desc')

const columns: { key: SortKey, label: string, class?: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'number', label: 'Number' },
  { key: 'type', label: 'Type' },
  { key: 'last', label: 'Last message' },
]

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sortKey.value = key
  // Newest-first and A–Z are the useful starting points for their columns.
  sortDir.value = key === 'last' ? 'desc' : 'asc'
}

function ariaSort(key: SortKey) {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

/** The timestamp shown in the last column, and sorted on. */
function lastActivity(chat: ScopedChat): string | undefined {
  return chat.lastMessageAt ?? chat.updatedAt
}

function lastActivityMs(chat: ScopedChat): number | undefined {
  const iso = lastActivity(chat)
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Rows with nothing in the sorted column sink to the bottom in both directions.
 * Flipping the sort to bring the blanks to the top is never what anyone wanted.
 */
function missingLast<T>(a: T | undefined, b: T | undefined, cmp: (x: T, y: T) => number, dir: number): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return dir * cmp(a, b)
}

const sorted = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1
  const byName = (a: ScopedChat, b: ScopedChat) => a.name.localeCompare(b.name)

  return [...filtered.value].sort((a, b) => {
    switch (sortKey.value) {
      case 'name':
        return dir * byName(a, b)
      case 'number':
        return missingLast(a.number, b.number, (x, y) => x.localeCompare(y, undefined, { numeric: true }), dir) || byName(a, b)
      case 'type':
        return dir * (Number(Boolean(a.isGroup)) - Number(Boolean(b.isGroup))) || byName(a, b)
      case 'last':
        return missingLast(lastActivityMs(a), lastActivityMs(b), (x, y) => x - y, dir) || byName(a, b)
    }
  })
})

// ── formatting ─────────────────────────────────────────────────────────────
const count = new Intl.NumberFormat()
const stamp = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatLastActivity(chat: ScopedChat): string {
  const ms = lastActivityMs(chat)
  return ms === undefined ? '—' : stamp.format(ms)
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Chats</DialogTitle>
        <DialogDescription>
          Every conversation this account has recorded — the history imported at
          pairing plus everything since.
        </DialogDescription>
      </DialogHeader>

      <div class="relative">
        <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="search" placeholder="Search by name or number" class="pl-8" />
      </div>

      <!--
        The max height goes on the table's own container, not on this wrapper:
        that container is the scrolling element, and a sticky header only sticks
        to its nearest scrolling ancestor.
      -->
      <div class="min-h-0 rounded-md border [&_[data-slot=table-container]]:max-h-[60vh]">
        <Table>
          <TableHeader class="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead
                v-for="column in columns"
                :key="column.key"
                :aria-sort="ariaSort(column.key)"
              >
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="toggleSort(column.key)"
                >
                  {{ column.label }}
                  <ChevronUpIcon v-if="sortKey === column.key && sortDir === 'asc'" class="size-3.5" />
                  <ChevronDownIcon v-else-if="sortKey === column.key" class="size-3.5" />
                  <ArrowUpDownIcon v-else class="size-3.5 text-muted-foreground/50" />
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            <template v-if="loading">
              <TableRow v-for="n in 6" :key="n">
                <TableCell>
                  <div class="flex items-center gap-3">
                    <Skeleton class="size-8 shrink-0 rounded-full" />
                    <Skeleton class="h-4 w-36" />
                  </div>
                </TableCell>
                <TableCell><Skeleton class="h-4 w-28" /></TableCell>
                <TableCell><Skeleton class="h-4 w-16" /></TableCell>
                <TableCell><Skeleton class="h-4 w-32" /></TableCell>
              </TableRow>
            </template>

            <TableRow v-else-if="!chats.length">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                No conversations recorded yet. They appear here once messages are
                exchanged, or once a history import completes.
              </TableCell>
            </TableRow>

            <TableRow v-else-if="!sorted.length">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                Nothing matches “{{ search }}”.
              </TableCell>
            </TableRow>

            <!-- v-for and v-else cannot share an element: v-if wins the priority
                 contest and the v-else loses its adjacent branch. -->
            <template v-else>
              <TableRow v-for="chat in sorted" :key="chat.jid">
                <TableCell class="max-w-[18rem]">
                  <div class="flex items-center gap-3">
                    <img
                      v-if="chat.profilePicUrl"
                      :src="chat.profilePicUrl"
                      alt=""
                      class="size-8 shrink-0 rounded-full object-cover"
                    >
                    <span v-else class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <UsersIcon v-if="chat.isGroup" class="size-3.5 text-muted-foreground" />
                      <UserIcon v-else class="size-3.5 text-muted-foreground" />
                    </span>
                    <span class="truncate" :title="chat.name">{{ chat.name }}</span>
                  </div>
                </TableCell>

                <!--
                  Digits only, deliberately. Formatting a number for reading needs
                  country-specific rules, and this app never applies those locally.
                -->
                <TableCell class="tabular-nums">
                  {{ chat.number ? `+${chat.number}` : '—' }}
                </TableCell>

                <TableCell>
                  <Badge :variant="chat.isGroup ? 'outline' : 'secondary'" class="text-[10px]">
                    {{ chat.isGroup ? 'group' : 'contact' }}
                  </Badge>
                </TableCell>

                <TableCell class="tabular-nums" :title="lastActivity(chat) ?? ''">
                  {{ formatLastActivity(chat) }}
                </TableCell>
              </TableRow>
            </template>
          </TableBody>
        </Table>
      </div>

      <!--
        The button sits out here rather than in a TableFooter: the scrolling
        element is the table's own container, so a footer row would scroll out of
        sight exactly when it is needed.
      -->
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">
          <template v-if="loading">
            Loading conversations…
          </template>
          <!-- Search first: the shortfall line below is true permanently on most
               accounts, and would otherwise mask the match count for good. -->
          <template v-else-if="search.trim()">
            {{ count.format(sorted.length) }} of {{ count.format(chats.length) }} chats match.
          </template>
          <template v-else-if="hasMore">
            Showing {{ count.format(chats.length) }}<template v-if="total"> of {{ count.format(total) }}</template> chats.
          </template>
          <template v-else-if="unlistable">
            Showing {{ count.format(chats.length) }} conversations with recorded
            messages. The Chats card counts {{ count.format(total ?? 0) }} chat
            records; the rest have no messages stored, so there is nothing to list.
          </template>
          <template v-else>
            {{ count.format(chats.length) }} {{ chats.length === 1 ? 'chat' : 'chats' }}.
          </template>
          <span v-if="loadFailed" class="text-destructive">
            That page could not be loaded. Try again.
          </span>
        </p>

        <Button
          v-if="hasMore && !loading"
          variant="outline"
          size="sm"
          class="shrink-0"
          :disabled="loadingMore"
          @click="loadPage(nextSkip)"
        >
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
