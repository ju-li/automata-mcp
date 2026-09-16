<script setup lang="ts">
import { ArrowUpDownIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon, UserIcon, UsersIcon } from '@lucide/vue'

/**
 * Every conversation on the account, as a paged table.
 *
 * Opened from the dashboard's "Chats" stat card. The two numbers do not measure
 * the same thing and must not be subtracted from one another: the card is
 * Evolution's `_count.Chat`, rows in its `Chat` table, while this list is
 * `DISTINCT ON (remoteJid)` over `"Message"`. History sync records a chat for
 * every conversation the phone lists but keeps only the messages it was actually
 * sent, so a shortfall here is usually conversations with nothing stored to show
 * — not a page boundary.
 *
 * Searching, sorting and paging all happen on the server, over the whole
 * account. They used to happen here over whatever had been fetched, which meant
 * a search answered about the loaded pool rather than about the account — and
 * the pool was capped. The server now walks the listing once into a short-lived
 * cache and answers from it, so a page is a page of everything.
 */
const props = defineProps<{
  instanceId: string
  /** WhatsApp shows a phone number beside each chat; Telegram shows its @username. */
  kind: InstanceKind
  open: boolean
  /** The dashboard's chat count. Explains a shortfall; never decides whether to fetch. */
  total?: number
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

type SortKey = 'name' | 'number' | 'type' | 'last'

interface ChatPageResponse {
  chats: ScopedChat[]
  hasMore: boolean
  total?: number
  /** WhatsApp only: the cached listing is capped. */
  truncated?: boolean
  /** WhatsApp only: Evolution could not be asked for all of it. */
  incomplete?: boolean
}

const truncated = ref(false)
const incomplete = ref(false)

/**
 * Deferred, for the same reason as the token scope picker: a cold listing can
 * spend seconds inside Evolution's contact and group lookups, and awaiting it in
 * setup would hold the whole dialog off the screen — which reads as a click that
 * did nothing. Nothing is fetched until the dialog is actually opened.
 */
const table = useTablePage<ScopedChat, SortKey>({
  sort: 'last',
  dir: 'desc',
  descendingFirst: ['last'],
  async load({ page, limit, q, sort, dir }) {
    const response = await $fetch<ChatPageResponse>(
      `/api/instances/${props.instanceId}/chats`,
      { query: { page, limit, q, sort, dir } },
    )

    truncated.value = response.truncated === true
    incomplete.value = response.incomplete === true

    return { rows: response.chats, hasMore: response.hasMore, total: response.total }
  },
})

watch(() => props.open, (open) => {
  if (!open) return
  truncated.value = false
  incomplete.value = false
  table.reset()
})

/**
 * The list is short and there is no next page — so the missing conversations are
 * ones Evolution cannot list, not ones behind an offset.
 *
 * `total` has to have been measured for this to mean anything. Read as `?? 0` it
 * is true on every first render, which put "showing 0 conversations" under a
 * table that was still loading.
 */
const unlistable = computed(() =>
  !table.loading.value && table.total.value !== undefined
  && !table.hasMore.value && !truncated.value && !incomplete.value
  && !table.q.value.trim()
  && table.total.value < (props.total ?? 0),
)

/** The identifier shown beside a chat's name: a phone number, or a Telegram @username. */
function secondaryId(chat: ScopedChat): string | undefined {
  return props.kind === 'telegram' ? chat.username : chat.number
}

const columns = computed<{ key: SortKey, label: string }[]>(() => [
  { key: 'name', label: 'Name' },
  { key: 'number', label: props.kind === 'telegram' ? 'Username' : 'Number' },
  { key: 'type', label: 'Type' },
  { key: 'last', label: 'Last message' },
])

/** The timestamp shown in the last column. */
function lastActivity(chat: ScopedChat): string | undefined {
  return chat.lastMessageAt ?? chat.updatedAt
}

const count = new Intl.NumberFormat()
const stamp = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatLastActivity(chat: ScopedChat): string {
  const iso = lastActivity(chat)
  if (!iso) return '—'
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '—' : stamp.format(ms)
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Chats</DialogTitle>
        <DialogDescription v-if="kind === 'telegram'">
          Every chat synced for this account — new messages as they arrive, and older
          history within this connection's sync limits.
        </DialogDescription>
        <DialogDescription v-else>
          Every conversation this account has recorded — the history imported at
          pairing plus everything since.
        </DialogDescription>
      </DialogHeader>

      <div class="relative">
        <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="table.q.value"
          :placeholder="kind === 'telegram' ? 'Search by name or username' : 'Search by name or number'"
          class="pl-8"
        />
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
                :aria-sort="table.ariaSort(column.key)"
              >
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="table.toggleSort(column.key)"
                >
                  {{ column.label }}
                  <ChevronUpIcon v-if="table.sort.value === column.key && table.dir.value === 'asc'" class="size-3.5" />
                  <ChevronDownIcon v-else-if="table.sort.value === column.key" class="size-3.5" />
                  <ArrowUpDownIcon v-else class="size-3.5 text-muted-foreground/50" />
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            <template v-if="table.loading.value">
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

            <TableRow v-else-if="!table.rows.value.length && table.q.value.trim()">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                Nothing matches “{{ table.q.value }}”.
              </TableCell>
            </TableRow>

            <TableRow v-else-if="!table.rows.value.length">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                <template v-if="kind === 'telegram'">
                  No chats synced yet. They appear here once the account is linked and
                  its chat list has synced.
                </template>
                <template v-else>
                  No conversations recorded yet. They appear here once messages are
                  exchanged, or once a history import completes.
                </template>
              </TableCell>
            </TableRow>

            <!-- v-for and v-else cannot share an element: v-if wins the priority
                 contest and the v-else loses its adjacent branch. -->
            <template v-else>
              <TableRow v-for="chat in table.rows.value" :key="chat.jid">
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
                  <template v-if="kind === 'telegram'">
                    {{ chat.username ? `@${chat.username}` : '—' }}
                  </template>
                  <template v-else>
                    {{ secondaryId(chat) ? `+${secondaryId(chat)}` : '—' }}
                  </template>
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
        Out here rather than in a TableFooter: the scrolling element is the
        table's own container, so a footer row would scroll out of sight exactly
        when it is needed.
      -->
      <div class="space-y-2">
        <TablePagination
          :page="table.page.value"
          :page-size="table.pageSize"
          :row-count="table.rows.value.length"
          :total="table.total.value"
          :has-more="table.hasMore.value"
          :loading="table.loading.value"
          noun="chats"
          @update:page="value => table.page.value = value"
        />

        <p v-if="table.failed.value" class="text-xs text-destructive">
          That page could not be loaded. Try again.
        </p>
        <p v-else-if="incomplete" class="text-xs text-muted-foreground">
          Evolution could not be asked for the whole list, so this may be short.
        </p>
        <p v-else-if="truncated" class="text-xs text-muted-foreground">
          This account has more conversations than this list holds.
        </p>
        <p v-else-if="unlistable" class="text-xs text-muted-foreground">
          Showing {{ count.format(table.total.value ?? 0) }} conversations with recorded
          messages. The Chats card counts {{ count.format(total ?? 0) }} chat
          records; the rest have no messages stored, so there is nothing to list.
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
