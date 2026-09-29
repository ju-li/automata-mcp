<script setup lang="ts">
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from '@lucide/vue'

/**
 * Every message on the account, as a paged table.
 *
 * Opened from the dashboard's "Messages" stat card. Searching and paging happen
 * in SQL across the whole account — a message table runs to six figures, so a
 * page loaded into the browser could never be searched honestly.
 *
 * **Only Time is sortable, and that is a limit rather than an omission.** A
 * sender's name and a chat's name are resolved after the query, from Evolution's
 * contact table and its group subjects, so ordering by either could only reach
 * the raw id — and a name sort that silently ordered one page would be worse
 * than no sort at all.
 *
 * The counts along the bottom are not decoration. A page that drops a class of
 * row — a reaction, a deletion, a control record — reads as a complete one
 * unless it says otherwise.
 */
const props = defineProps<{
  instanceId: string
  kind: InstanceKind
  open: boolean
  /** The dashboard's message count. Explains a shortfall; never decides whether to fetch. */
  total?: number
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

/** The one column this table can order by. See above. */
type SortKey = 'time'

interface MessageRow {
  key: string
  chat: string
  author?: string
  text?: string
  timestamp?: string
  fromMe: boolean
  /** Content that exists and cannot be rendered: an encrypted edit, a photo, a file. */
  note?: string
}

interface WhatsappMessage {
  id?: string
  chatJid: string
  chatName: string
  fromMe: boolean
  author?: string
  timestamp?: string
  type?: string
  text?: string
  unreadable?: string
}

interface TelegramMessageRow {
  id: number
  chatId?: string
  chatTitle?: string
  fromMe: boolean
  author?: string
  timestamp: string
  text?: string
  media?: string
}

interface WhatsappResponse {
  messages: WhatsappMessage[]
  hasMore: boolean
  total?: number
  protocolMessagesExcluded: number
  reactionsExcluded: boolean
}

interface TelegramResponse {
  messages: TelegramMessageRow[]
  hasMore: boolean
  total?: number
  deletedExcluded: number
  serviceMessagesExcluded: number
}

/** What this page left out, in the words of whichever backend answered. */
const excluded = ref<string[]>([])

const table = useTablePage<MessageRow, SortKey>({
  sort: 'time',
  dir: 'desc',
  descendingFirst: ['time'],
  async load({ page, limit, q, dir }) {
    const query = { page, limit, q, order: dir === 'asc' ? 'oldest' : 'newest' }
    const url = `/api/instances/${props.instanceId}/messages`

    if (props.kind === 'telegram') {
      const response = await $fetch<TelegramResponse>(url, { query })
      excluded.value = [
        ...(response.deletedExcluded ? [`${count.format(response.deletedExcluded)} deleted`] : []),
        ...(response.serviceMessagesExcluded ? [`${count.format(response.serviceMessagesExcluded)} service`] : []),
      ]
      return {
        hasMore: response.hasMore,
        total: response.total,
        rows: response.messages.map(message => ({
          key: `${message.chatId ?? ''}:${message.id}`,
          chat: message.chatTitle || message.chatId || '—',
          author: message.author,
          text: message.text,
          timestamp: message.timestamp,
          fromMe: message.fromMe,
          note: message.text ? undefined : message.media,
        })),
      }
    }

    const response = await $fetch<WhatsappResponse>(url, { query })
    excluded.value = [
      ...(response.reactionsExcluded ? ['reactions'] : []),
      ...(response.protocolMessagesExcluded
        ? [`${count.format(response.protocolMessagesExcluded)} control records`]
        : []),
    ]
    return {
      hasMore: response.hasMore,
      total: response.total,
      rows: response.messages.map((message, index) => ({
        key: `${message.chatJid}:${message.id ?? index}`,
        chat: message.chatName,
        author: message.author,
        text: message.text,
        timestamp: message.timestamp,
        fromMe: message.fromMe,
        note: message.text ? undefined : unreadableLabel(message),
      })),
    }
  },
})

/** Content that is there and cannot be shown, named rather than left blank. */
function unreadableLabel(message: WhatsappMessage): string | undefined {
  if (message.unreadable === 'encrypted-edit') return 'encrypted edit'
  if (message.unreadable) return 'encrypted'
  return message.type
}

watch(() => props.open, (open) => {
  if (!open) return
  excluded.value = []
  table.reset()
})

const count = new Intl.NumberFormat()
const stamp = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatTimestamp(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '—' : stamp.format(ms)
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>Messages</DialogTitle>
        <DialogDescription v-if="kind === 'telegram'">
          Every message synced for this account, newest first. Search covers all of
          them, not just this page.
        </DialogDescription>
        <DialogDescription v-else>
          Every message this account has recorded, newest first. Search covers all of
          them, not just this page.
        </DialogDescription>
      </DialogHeader>

      <div class="relative">
        <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="table.q.value" placeholder="Search message text" class="pl-8" />
      </div>

      <div class="min-h-0 rounded-md border [&_[data-slot=table-container]]:max-h-[60vh]">
        <Table>
          <TableHeader class="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Chat</TableHead>
              <TableHead>Sender</TableHead>
              <TableHead>Message</TableHead>
              <TableHead :aria-sort="table.ariaSort('time')">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="table.toggleSort('time')"
                >
                  Time
                  <ChevronUpIcon v-if="table.dir.value === 'asc'" class="size-3.5" />
                  <ChevronDownIcon v-else class="size-3.5" />
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            <template v-if="table.loading.value">
              <TableRow v-for="n in 8" :key="n">
                <TableCell><Skeleton class="h-4 w-32" /></TableCell>
                <TableCell><Skeleton class="h-4 w-24" /></TableCell>
                <TableCell><Skeleton class="h-4 w-64" /></TableCell>
                <TableCell><Skeleton class="h-4 w-32" /></TableCell>
              </TableRow>
            </template>

            <TableRow v-else-if="table.unavailable.value">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                This connection cannot read messages yet. {{ table.unavailable.value }}
              </TableCell>
            </TableRow>

            <TableRow v-else-if="!table.rows.value.length && table.q.value.trim()">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                Nothing matches “{{ table.q.value }}”.
              </TableCell>
            </TableRow>

            <TableRow v-else-if="!table.rows.value.length">
              <TableCell colspan="4" class="py-8 text-center text-sm text-muted-foreground">
                No messages recorded yet.
              </TableCell>
            </TableRow>

            <template v-else>
              <TableRow v-for="message in table.rows.value" :key="message.key">
                <TableCell class="max-w-[12rem]">
                  <span class="block truncate" :title="message.chat">{{ message.chat }}</span>
                </TableCell>

                <!--
                  A message you sent has no author at all: `fromMe` already says
                  so, in a field that cannot contradict itself. The alternative is
                  the sending device's localised word for its own owner sitting
                  next to the account's real name on the very same message.
                -->
                <TableCell class="max-w-[10rem]">
                  <span v-if="message.fromMe" class="text-muted-foreground">You</span>
                  <span v-else class="block truncate" :title="message.author">
                    {{ message.author ?? '—' }}
                  </span>
                </TableCell>

                <TableCell class="max-w-[28rem]">
                  <span v-if="message.text" class="block truncate" :title="message.text">{{ message.text }}</span>
                  <span v-else-if="message.note" class="text-muted-foreground italic">[{{ message.note }}]</span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>

                <TableCell class="tabular-nums" :title="message.timestamp ?? ''">
                  {{ formatTimestamp(message.timestamp) }}
                </TableCell>
              </TableRow>
            </template>
          </TableBody>
        </Table>
      </div>

      <div class="space-y-2">
        <TablePagination
          :page="table.page.value"
          :page-size="table.pageSize"
          :row-count="table.rows.value.length"
          :total="table.total.value"
          :has-more="table.hasMore.value"
          :loading="table.loading.value"
          noun="messages"
          @update:page="value => table.page.value = value"
        />

        <p v-if="table.failed.value" class="text-xs text-destructive">
          That page could not be loaded. Try again.
        </p>
        <p v-else-if="excluded.length" class="text-xs text-muted-foreground">
          Left out of this count: {{ excluded.join(', ') }}.
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
