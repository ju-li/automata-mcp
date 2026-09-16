<script setup lang="ts">
import { ArrowUpDownIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon, UserIcon, UsersIcon } from '@lucide/vue'

/**
 * Every contact Evolution holds for the account, as a paged table.
 *
 * Opened from the dashboard's "Contacts" stat card. Unlike Chats, the card and
 * this table count the **same** Evolution table, so a shortfall here is not
 * expected and is not explained away — if the two disagree, something is wrong
 * rather than merely unlistable.
 *
 * Searching, sorting and paging are the server's: `findContacts` returns the
 * whole table or nothing, so the server memoises it and answers pages from it.
 */
const props = defineProps<{
  instanceId: string
  open: boolean
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

type SortKey = 'name' | 'number'

interface ContactRow {
  jid: string
  name: string
  number?: string
  isGroup: boolean
  profilePicUrl?: string
}

interface ContactPageResponse {
  contacts: ContactRow[]
  hasMore: boolean
  total: number
}

const table = useTablePage<ContactRow, SortKey>({
  sort: 'name',
  dir: 'asc',
  async load({ page, limit, q, sort, dir }) {
    const response = await $fetch<ContactPageResponse>(
      `/api/instances/${props.instanceId}/contacts`,
      { query: { page, limit, q, sort, dir } },
    )
    return { rows: response.contacts, hasMore: response.hasMore, total: response.total }
  },
})

watch(() => props.open, (open) => {
  if (open) table.reset()
})

const columns: { key: SortKey, label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'number', label: 'Number' },
]
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Contacts</DialogTitle>
        <DialogDescription>
          Everyone this account has a contact record for — saved address-book names
          where WhatsApp has one, and the bare number where it does not.
        </DialogDescription>
      </DialogHeader>

      <div class="relative">
        <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="table.q.value" placeholder="Search by name or number" class="pl-8" />
      </div>

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
              <TableRow v-for="n in 8" :key="n">
                <TableCell>
                  <div class="flex items-center gap-3">
                    <Skeleton class="size-8 shrink-0 rounded-full" />
                    <Skeleton class="h-4 w-40" />
                  </div>
                </TableCell>
                <TableCell><Skeleton class="h-4 w-28" /></TableCell>
              </TableRow>
            </template>

            <TableRow v-else-if="!table.rows.value.length && table.q.value.trim()">
              <TableCell colspan="2" class="py-8 text-center text-sm text-muted-foreground">
                Nothing matches “{{ table.q.value }}”.
              </TableCell>
            </TableRow>

            <TableRow v-else-if="!table.rows.value.length">
              <TableCell colspan="2" class="py-8 text-center text-sm text-muted-foreground">
                No contacts recorded yet. They appear here as messages arrive, or once
                a history import completes.
              </TableCell>
            </TableRow>

            <template v-else>
              <TableRow v-for="contact in table.rows.value" :key="contact.jid">
                <TableCell class="max-w-[22rem]">
                  <div class="flex items-center gap-3">
                    <img
                      v-if="contact.profilePicUrl"
                      :src="contact.profilePicUrl"
                      alt=""
                      class="size-8 shrink-0 rounded-full object-cover"
                    >
                    <span v-else class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <UsersIcon v-if="contact.isGroup" class="size-3.5 text-muted-foreground" />
                      <UserIcon v-else class="size-3.5 text-muted-foreground" />
                    </span>
                    <span class="truncate" :title="contact.name">{{ contact.name }}</span>
                  </div>
                </TableCell>

                <!--
                  Digits only, and only where the id really is a phone number. A
                  LID is a per-user identity with no country code to read off it,
                  and showing one as a number is a misattribution.
                -->
                <TableCell class="tabular-nums">
                  {{ contact.number ? `+${contact.number}` : '—' }}
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
          noun="contacts"
          @update:page="value => table.page.value = value"
        />

        <p v-if="table.failed.value" class="text-xs text-destructive">
          That page could not be loaded. Try again.
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
