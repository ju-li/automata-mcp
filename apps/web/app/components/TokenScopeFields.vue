<script setup lang="ts">
import { PlusIcon, SearchIcon, UsersIcon, XIcon } from '@lucide/vue'

/**
 * The scope editor, shared by the create and edit dialogs so the two cannot
 * drift into disagreeing about what a scope is.
 */
const props = defineProps<{ instanceId: string, kind: InstanceKind }>()
const scope = defineModel<TokenScope>({ required: true })

const isPostgres = computed(() => props.kind === 'postgres')

// Deliberately not awaited. A top-level await makes setup() async, and Vue then
// withholds the entire component until every fetch settles — so the chats call,
// which can spend eight seconds inside Evolution's group lookup, would keep the
// Actions section (whose data is in-process and instant) off the screen with it.
// The dialog mounts on click, so that stall reads as a click that did nothing.
const { data: toolData, status: toolStatus } = useFetch<{ tools: McpToolInfo[] }>(
  () => `/api/instances/${props.instanceId}/mcp-tools`,
  { key: `mcp-tools-${props.instanceId}`, lazy: true },
)
// Only the axis this kind actually has is fetched. `immediate: false` on the
// other one matters: asking a WhatsApp connection for its tables answers 404,
// and a 404 in the console on every open reads as a bug.
const { data: chatData, status: chatStatus } = useFetch<{ chats: ScopedChat[] }>(
  () => `/api/instances/${props.instanceId}/chats`,
  { lazy: true, immediate: !isPostgres.value },
)
const { data: tableData, status: tableStatus } = useFetch<{ tables: ScopedTable[], hasMore: boolean }>(
  () => `/api/instances/${props.instanceId}/tables`,
  { lazy: true, immediate: isPostgres.value, query: { limit: 500 } },
)

// Chats picked by JID may not be in the fetched list — a number added by hand,
// or one whose conversation has since aged out. Keep our own record of them so
// the selection can always be rendered with a name.
const extraChats = ref<ScopedChat[]>([])
const search = ref('')
const tableSearch = ref('')
const manualNumber = ref('')
const resolving = ref(false)
const manualError = ref('')

// 'idle' counts as loading: it is what status reads for the tick before the
// request is dispatched, and treating it as settled flashes the empty state.
const loading = (status: Ref<string>) => computed(() => status.value === 'idle' || status.value === 'pending')
const toolsLoading = loading(toolStatus)
const chatsLoading = loading(chatStatus)
const tablesLoading = loading(tableStatus)

const visibleTables = computed(() => {
  const rows = tableData.value?.tables ?? []
  const q = tableSearch.value.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(t => t.qname.toLowerCase().includes(q))
})

const knownChats = computed<ScopedChat[]>(() => {
  const seen = new Map<string, ScopedChat>()
  for (const chat of [...(chatData.value?.chats ?? []), ...extraChats.value]) {
    if (!seen.has(chat.jid)) seen.set(chat.jid, chat)
  }
  return [...seen.values()]
})

const visibleChats = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return knownChats.value
  return knownChats.value.filter(c =>
    c.name.toLowerCase().includes(q) || c.jid.toLowerCase().includes(q),
  )
})

const selectedChats = computed(() =>
  scope.value.chat_jids.map(jid =>
    knownChats.value.find(c => c.jid === jid) ?? { jid, name: jid.split('@')[0]! },
  ),
)

/**
 * Add or remove one id on one axis.
 *
 * One function rather than one per axis: the set-dedupe is the only logic here,
 * and it was being maintained in three copies that differed solely in which key
 * they rebuilt.
 */
type ScopeList = 'tool_names' | 'chat_jids' | 'table_names'

function toggle(key: ScopeList, value: string, on: boolean) {
  const next = new Set(scope.value[key])
  on ? next.add(value) : next.delete(value)
  scope.value = { ...scope.value, [key]: [...next] }
}

/**
 * The muted line under a chat's name: a number for a person, a size for a group.
 * Two chats can share a display name, and this is what tells them apart.
 *
 * Digits only, deliberately. Formatting a number for reading needs
 * country-specific rules, and this app never applies those locally.
 */
function secondaryLine(chat: ScopedChat): string {
  if (chat.isGroup) {
    if (!chat.participantCount) return ''
    return chat.participantCount === 1 ? '1 member' : `${chat.participantCount} members`
  }
  return chat.number ? `+${chat.number}` : ''
}

async function addByNumber() {
  manualError.value = ''
  const number = manualNumber.value.trim()
  if (!number) return

  resolving.value = true
  try {
    const result = await $fetch<{ jid: string, name?: string }>(
      `/api/instances/${props.instanceId}/chats/resolve`,
      { method: 'POST', body: { number } },
    )
    if (!knownChats.value.some(c => c.jid === result.jid)) {
      // The number under the name comes off the resolved JID, not what was typed:
      // Evolution's rules may have rewritten it, and the JID is what scope matches.
      const resolvedNumber = result.jid.split('@')[0]!
      extraChats.value.push({
        jid: result.jid,
        name: result.name?.trim() || resolvedNumber,
        isGroup: false,
        number: resolvedNumber,
      })
    }
    toggle('chat_jids', result.jid, true)
    manualNumber.value = ''
  }
  catch (err: any) {
    manualError.value = apiErrorMessage(err, 'Could not add that number')
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- ── actions ─────────────────────────────────────────────────────── -->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">
          Actions
        </h3>
        <p class="text-xs text-muted-foreground">
          What this token is allowed to do.
        </p>
      </div>

      <ScopeModeRadio
        :model-value="scope.all_tools"
        name="tools"
        all-label="All actions"
        some-label="Only selected actions"
        @update:model-value="scope = { ...scope, all_tools: $event }"
      />

      <div v-if="!scope.all_tools" class="space-y-2 rounded-md border p-3">
        <div v-if="toolsLoading" class="space-y-3" aria-busy="true">
          <span class="sr-only">Loading actions…</span>
          <div v-for="n in 3" :key="n" class="flex items-start gap-3">
            <Skeleton class="mt-0.5 size-4 rounded-sm" />
            <div class="min-w-0 flex-1 space-y-1.5">
              <Skeleton class="h-4 w-40" />
              <Skeleton class="h-3 w-full" />
            </div>
          </div>
        </div>

        <template v-else>
          <div
            v-for="tool in toolData?.tools ?? []"
            :key="tool.name"
            class="flex items-start gap-3"
          >
            <Checkbox
              :id="`tool-${tool.name}`"
              :model-value="scope.tool_names.includes(tool.name)"
              class="mt-0.5"
              @update:model-value="toggle('tool_names', tool.name, $event === true)"
            />
            <div class="min-w-0">
              <Label :for="`tool-${tool.name}`" class="flex items-center gap-2 font-normal">
                {{ tool.title }}
                <Badge :variant="tool.readOnly ? 'secondary' : 'outline'" class="text-[10px]">
                  {{ tool.readOnly ? 'read' : 'write' }}
                </Badge>
              </Label>
              <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {{ tool.description }}
              </p>
            </div>
          </div>
        </template>
      </div>
    </section>

    <Separator />

    <!-- ── tables (databases only) ─────────────────────────────────────── -->
    <section v-if="isPostgres" class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">
          Tables
        </h3>
        <p class="text-xs text-muted-foreground">
          Which tables this token can reach. Checked against the query plan before
          any row is read, so a query that joins outside this list is refused
          rather than silently returning less.
        </p>
      </div>

      <ScopeModeRadio
        :model-value="scope.all_tables"
        name="tables"
        all-label="All tables the connection can read"
        some-label="Only selected tables"
        @update:model-value="scope = { ...scope, all_tables: $event }"
      />

      <div v-if="!scope.all_tables" class="space-y-3 rounded-md border p-3">
        <div v-if="scope.table_names.length" class="flex flex-wrap gap-1.5">
          <Badge
            v-for="qname in scope.table_names"
            :key="qname"
            variant="secondary"
            class="gap-1 font-mono text-[10px]"
          >
            {{ qname }}
            <button type="button" aria-label="Remove table" @click="toggle('table_names', qname, false)">
              <XIcon class="size-3" />
            </button>
          </Badge>
        </div>

        <div class="relative">
          <SearchIcon class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input v-model="tableSearch" placeholder="Search tables" class="pl-8" />
        </div>

        <div v-if="tablesLoading" class="space-y-2" aria-busy="true">
          <span class="sr-only">Loading tables…</span>
          <Skeleton v-for="n in 4" :key="n" class="h-8 w-full" />
        </div>

        <p v-else-if="!visibleTables.length" class="py-2 text-xs text-muted-foreground">
          No tables to show. If this database is reachable but empty here, the role
          it connects as has no SELECT grant on anything.
        </p>

        <div v-else class="max-h-64 space-y-1 overflow-y-auto">
          <div
            v-for="table in visibleTables"
            :key="table.qname"
            class="flex items-start gap-3 rounded-sm px-1 py-1.5 hover:bg-accent"
          >
            <Checkbox
              :id="`table-${table.qname}`"
              :model-value="scope.table_names.includes(table.qname)"
              class="mt-0.5"
              @update:model-value="toggle('table_names', table.qname, $event === true)"
            />
            <Label :for="`table-${table.qname}`" class="min-w-0 font-normal">
              <span class="block truncate font-mono text-xs">{{ table.qname }}</span>
              <span class="block text-xs text-muted-foreground">{{ table.kind }}</span>
            </Label>
          </div>
        </div>

        <p v-if="tableData?.hasMore" class="text-xs text-muted-foreground">
          More tables exist than are listed. Search to narrow the list.
        </p>
      </div>
    </section>

    <!-- ── chats (WhatsApp only) ───────────────────────────────────────── -->
    <section v-else class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">
          Chats
        </h3>
        <p class="text-xs text-muted-foreground">
          Which conversations this token can read and reply in.
        </p>
      </div>

      <ScopeModeRadio
        :model-value="scope.all_chats"
        name="chats"
        all-label="All chats"
        some-label="Only selected chats"
        @update:model-value="scope = { ...scope, all_chats: $event }"
      />

      <div v-if="!scope.all_chats" class="space-y-3 rounded-md border p-3">
        <div v-if="selectedChats.length" class="flex flex-wrap gap-1.5">
          <Badge
            v-for="chat in selectedChats"
            :key="chat.jid"
            variant="secondary"
            class="gap-1"
          >
            {{ chat.name }}
            <button type="button" :aria-label="`Remove ${chat.name}`" @click="toggle('chat_jids', chat.jid, false)">
              <XIcon class="size-3" />
            </button>
          </Badge>
        </div>

        <div class="relative">
          <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" placeholder="Search conversations" class="pl-8" />
        </div>

        <div class="max-h-52 space-y-1 overflow-y-auto">
          <div v-if="chatsLoading" class="space-y-1" aria-busy="true" aria-live="polite">
            <span class="sr-only">Loading conversations…</span>
            <div v-for="n in 4" :key="n" class="flex items-center gap-3 px-2 py-1.5">
              <Skeleton class="size-4 rounded-sm" />
              <Skeleton class="size-8 rounded-full" />
              <div class="min-w-0 flex-1 space-y-1">
                <Skeleton class="h-3.5 w-32" />
                <Skeleton class="h-3 w-20" />
              </div>
            </div>
          </div>

          <p v-else-if="!knownChats.length" class="py-2 text-xs text-muted-foreground">
            No conversations recorded yet — they appear here once messages are
            exchanged. Add a number directly below.
          </p>

          <p v-else-if="!visibleChats.length" class="py-2 text-xs text-muted-foreground">
            Nothing matches “{{ search }}”.
          </p>

          <label
            v-for="chat in visibleChats"
            :key="chat.jid"
            class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
          >
            <Checkbox
              :model-value="scope.chat_jids.includes(chat.jid)"
              @update:model-value="toggle('chat_jids', chat.jid, $event === true)"
            />
            <img v-if="chat.profilePicUrl" :src="chat.profilePicUrl" alt="" class="size-8 rounded-full object-cover">
            <span v-else class="flex size-8 items-center justify-center rounded-full bg-muted">
              <UsersIcon v-if="chat.isGroup" class="size-3.5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ chat.name }}</span>
              <span
                v-if="secondaryLine(chat)"
                class="block truncate text-xs text-muted-foreground tabular-nums"
              >{{ secondaryLine(chat) }}</span>
            </span>
            <Badge v-if="chat.isGroup" variant="outline" class="text-[10px]">
              group
            </Badge>
          </label>
        </div>

        <div class="space-y-1 border-t pt-3">
          <Label for="manual-number" class="text-xs">Add by phone number</Label>
          <div class="flex gap-2">
            <Input
              id="manual-number"
              v-model="manualNumber"
              placeholder="5511999999999"
              class="min-w-0 flex-1"
              @keydown.enter.prevent="addByNumber"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              class="shrink-0"
              :disabled="resolving"
              aria-label="Add number"
              @click="addByNumber"
            >
              <PlusIcon class="size-4" />
            </Button>
          </div>
          <p v-if="manualError" class="text-xs text-destructive">
            {{ manualError }}
          </p>
          <p v-else class="text-xs text-muted-foreground">
            International format, no “+”. Checked against WhatsApp before it is added.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
