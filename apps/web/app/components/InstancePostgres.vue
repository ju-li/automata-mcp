<script setup lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import { ArrowLeftIcon, ArrowUpDownIcon, ChevronDownIcon, ChevronUpIcon, DatabaseIcon, SearchIcon, TableIcon } from '@lucide/vue'

/**
 * How many tables the dashboard asks for in its one request. Equal to
 * `MAX_TABLE_PAGE` in `server/utils/pg-catalog.ts`, which is server-only — the
 * endpoint refuses anything larger.
 */
const TABLE_FETCH_LIMIT = 1000

/**
 * The dashboard for a database connection.
 *
 * Deliberately not a re-skin of the WhatsApp panel: there is no pairing, no
 * profile and no message count, and rendering an empty version of any of those
 * would suggest a state this connection can be in. What it does have is a health
 * check, the tables it can reach, and the two things an owner needs — rotate the
 * connection string, remove the connection.
 */
const props = withDefaults(defineProps<{
  id: string
  /**
   * Whether this viewer may change the connection, as opposed to use it.
   *
   * Decided by the server and passed down from the page. It gates presentation
   * only — every control it hides is independently refused with a 403.
   */
  canManage?: boolean
}>(), { canManage: false })

interface StatusResponse {
  instance: PublicInstanceRow
  state: ConnectionState
  detail?: string
  error?: string
}

const id = computed(() => props.id)

const { data, refresh } = await useFetch<StatusResponse>(() => `/api/instances/${id.value}`)

// The table list is what makes the page useful, and it is a separate query, so
// it is fetched separately and lazily — a database with a slow catalog must not
// keep the token list off the screen.
const { data: tableData, status: tableStatus, refresh: refreshTables } = await useFetch<{
  tables: ScopedTable[]
  hasMore: boolean
}>(() => `/api/instances/${id.value}/tables`, { lazy: true, query: { limit: TABLE_FETCH_LIMIT } })

const state = computed<ConnectionState>(() => data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')
const tablesLoading = computed(() => tableStatus.value === 'idle' || tableStatus.value === 'pending')

// ── table list: search, schema filter, sort and paging, all in the browser ──
//
// Unlike the WhatsApp tables, this one is a catalog listing fetched whole in a
// single request, so filtering it locally answers about the database rather
// than about a page of it — up to the fetch ceiling. Past that ceiling the
// template says so, because a search over the first thousand tables that reads
// as a search over all of them is the failure a page must never hide.
type TableSort = 'name' | 'kind' | 'rows'

const PAGE_SIZE = 25
const ALL_SCHEMAS = '__all__' // reka's Select refuses an empty-string value

const tables = computed(() => tableData.value?.tables ?? [])
const q = ref('')
const schemaFilter = ref(ALL_SCHEMAS)
const sort = ref<TableSort>('name')
const dir = ref<'asc' | 'desc'>('asc')
const page = ref(1)

const schemas = computed(() => [...new Set(tables.value.map(t => t.schema))].sort())

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return tables.value.filter(t =>
    (schemaFilter.value === ALL_SCHEMAS || t.schema === schemaFilter.value)
    && (!needle || t.qname.toLowerCase().includes(needle) || t.comment?.toLowerCase().includes(needle)),
  )
})

const sorted = computed(() => {
  const sign = dir.value === 'asc' ? 1 : -1
  return [...filtered.value].sort((a, b) => {
    let order = 0
    if (sort.value === 'kind') {
      order = sign * a.kind.localeCompare(b.kind)
    }
    else if (sort.value === 'rows') {
      // An unanalysed table has no estimate. It goes last in either direction:
      // sorting it as zero would list it as the smallest table, which it may
      // not be.
      const ra = a.estimatedRows ?? null
      const rb = b.estimatedRows ?? null
      if (ra === null || rb === null) order = ra === rb ? 0 : ra === null ? 1 : -1
      else order = sign * (ra - rb)
    }
    else {
      return sign * a.qname.localeCompare(b.qname)
    }
    return order || a.qname.localeCompare(b.qname)
  })
})

const paged = computed(() => sorted.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const isFiltered = computed(() => q.value.trim() !== '' || schemaFilter.value !== ALL_SCHEMAS)

// Page 7 of a different question is not a page.
watch([q, schemaFilter, sort, dir], () => { page.value = 1 })

// A rotated DSN can point at a database without the schema being filtered on.
watch(schemas, (list) => {
  if (schemaFilter.value !== ALL_SCHEMAS && !list.includes(schemaFilter.value)) schemaFilter.value = ALL_SCHEMAS
})

function toggleSort(key: TableSort) {
  if (sort.value === key) {
    dir.value = dir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sort.value = key
  // Biggest first is the useful starting point for a row count.
  dir.value = key === 'rows' ? 'desc' : 'asc'
}

function ariaSort(key: TableSort) {
  if (sort.value !== key) return 'none'
  return dir.value === 'asc' ? 'ascending' : 'descending'
}

const sortColumns: { key: TableSort, label: string, class?: string }[] = [
  { key: 'name', label: 'Table' },
  { key: 'kind', label: 'Kind' },
  { key: 'rows', label: 'Rows (estimate)', class: 'justify-end' },
]

const { busy, run } = useApiAction()
const newDsn = ref('')
const editingDsn = ref(false)

// A health poll, not a pairing poll: this only reports, it never drives a state
// change the way asking Evolution for a QR does. Slow on purpose — each tick
// opens or reuses a real database connection and runs a query on the user's
// server, so it also stops while the tab is hidden rather than running forever
// behind a background tab.
const visibility = useDocumentVisibility()
useIntervalFn(() => {
  if (visibility.value === 'hidden') return
  refresh()
}, 30_000)

async function saveDsn() {
  if (!newDsn.value.trim()) return

  await run(
    async () => {
      await $fetch(`/api/instances/${id.value}/dsn`, {
        method: 'PATCH',
        body: { dsn: newDsn.value.trim() },
      })
      newDsn.value = ''
      editingDsn.value = false
      await refresh()
      await refreshTables()
    },
    {
      success: 'Connection string updated. Existing tokens keep working.',
      // Worth the server's own words: it names the refused host, the wrong
      // database, or the driver's error code.
      failure: 'Could not update the connection string',
    },
  )
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <NuxtLink to="/instances" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon class="size-4" />
        All connections
      </NuxtLink>

      <div class="group/title mt-2 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <InstanceTitle
            :id="id"
            :label="data?.instance.label"
            :can-manage="canManage"
            @renamed="refresh()"
          />
          <p class="truncate font-mono text-sm text-muted-foreground">
            {{ data?.instance.target || 'No connection string stored' }}
          </p>
        </div>
        <ConnectionBadge :state="state" kind="postgres" />
      </div>
    </div>

    <!-- ── health ──────────────────────────────────────────────────────── -->
    <Card>
      <CardContent class="flex items-start gap-3 pt-6">
        <DatabaseIcon class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 space-y-1">
          <p v-if="connected" class="text-sm font-medium">
            {{ data?.detail || 'Connected' }}
          </p>
          <template v-else>
            <p class="text-sm font-medium">
              Not reachable
            </p>
            <!-- The server's message names the failure; a generic "check your
                 settings" would send the user guessing. -->
            <p class="text-sm text-muted-foreground">
              {{ data?.error || 'This database did not answer.' }}
            </p>
          </template>
        </div>
      </CardContent>
    </Card>

    <!-- ── tables ──────────────────────────────────────────────────────── -->
    <section class="space-y-3">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="font-heading text-lg font-semibold">
          Tables
        </h2>
        <p v-if="tables.length" class="text-sm text-muted-foreground tabular-nums">
          <template v-if="isFiltered">
            {{ filtered.length.toLocaleString() }} of
          </template>
          {{ tables.length.toLocaleString() }}{{ tableData?.hasMore ? '+' : '' }} reachable
        </p>
      </div>

      <p class="text-sm text-muted-foreground">
        Everything the connecting role can read. A connector token can be limited
        to a subset of these when you create it.
      </p>

      <div v-if="tablesLoading" class="space-y-2">
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-full" />
      </div>

      <p v-else-if="!tableData?.tables?.length" class="rounded-md border p-4 text-sm text-muted-foreground">
        No tables are visible to this connection. Either the database is empty, or
        the role it connects as has no <span class="font-mono">SELECT</span> grant
        on anything.
      </p>

      <template v-else>
        <div class="flex flex-wrap gap-2">
          <div class="relative min-w-48 flex-1">
            <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="q" placeholder="Search by name or description" class="pl-8" />
          </div>

          <!-- One schema has nothing to choose between. -->
          <Select v-if="schemas.length > 1" v-model="schemaFilter">
            <SelectTrigger class="w-48" aria-label="Filter by schema">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="ALL_SCHEMAS">
                All schemas
              </SelectItem>
              <SelectItem v-for="schema in schemas" :key="schema" :value="schema" class="font-mono text-xs">
                {{ schema }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead
                  v-for="column in sortColumns"
                  :key="column.key"
                  :aria-sort="ariaSort(column.key)"
                >
                  <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    :class="column.class"
                    @click="toggleSort(column.key)"
                  >
                    {{ column.label }}
                    <ChevronUpIcon v-if="sort === column.key && dir === 'asc'" class="size-3.5" />
                    <ChevronDownIcon v-else-if="sort === column.key" class="size-3.5" />
                    <ArrowUpDownIcon v-else class="size-3.5 text-muted-foreground/50" />
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-if="!paged.length">
                <TableCell colspan="3" class="py-8 text-center text-sm text-muted-foreground">
                  No tables match these filters.
                </TableCell>
              </TableRow>
              <TableRow v-for="table in paged" :key="table.qname">
                <TableCell class="font-mono text-xs">
                  <div class="flex items-center gap-2">
                    <TableIcon class="size-3.5 shrink-0 text-muted-foreground" />
                    {{ table.qname }}
                  </div>
                  <p v-if="table.comment" class="mt-1 line-clamp-1 font-sans text-xs text-muted-foreground">
                    {{ table.comment }}
                  </p>
                </TableCell>
                <TableCell class="text-sm text-muted-foreground">
                  {{ table.kind }}
                </TableCell>
                <TableCell class="text-right text-sm text-muted-foreground">
                  <!-- reltuples is a planner statistic. Labelled an estimate in the
                       column header so it is never quoted back as a count. -->
                  {{ table.estimatedRows === null || table.estimatedRows === undefined ? '—' : table.estimatedRows.toLocaleString() }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePagination
          v-if="filtered.length > PAGE_SIZE"
          :page="page"
          :page-size="PAGE_SIZE"
          :row-count="paged.length"
          :total="filtered.length"
          :has-more="page * PAGE_SIZE < filtered.length"
          noun="tables"
          @update:page="page = $event"
        />

        <p v-if="tableData?.hasMore" class="text-xs text-muted-foreground">
          This database has more than {{ TABLE_FETCH_LIMIT.toLocaleString() }} reachable
          tables. Search, filters and sorting cover the first
          {{ TABLE_FETCH_LIMIT.toLocaleString() }}, taken alphabetically by schema and name.
        </p>
      </template>
    </section>

    <Separator />

    <!--
      Always shown, including while the database is unreachable. Hiding it would
      mean you could not revoke a token for a connection that is down — which is
      exactly when you would want to.
    -->
    <McpTokens
      :instance-id="id"
      kind="postgres"
      :connected="connected"
      :can-manage="canManage"
    />

    <template v-if="canManage">
      <Separator />

      <!-- ── controls ──────────────────────────────────────────────────── -->
      <section class="space-y-4">
        <h2 class="font-heading text-lg font-semibold">
          Manage
        </h2>

        <div v-if="editingDsn" class="max-w-xl space-y-2 rounded-md border p-4">
          <PostgresDsnInput v-model="newDsn" id-prefix="new-dsn" />
          <p class="text-xs text-muted-foreground">
            Checked by connecting before it is saved. Every connector token for this
            connection keeps working — they name the connection, not the credential.
          </p>
          <div class="flex gap-2 pt-1">
            <Button :disabled="busy || !newDsn.trim()" @click="saveDsn">
              {{ busy ? 'Checking…' : 'Save' }}
            </Button>
            <Button variant="ghost" :disabled="busy" @click="editingDsn = false; newDsn = ''">
              Cancel
            </Button>
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <Button v-if="!editingDsn" variant="outline" :disabled="busy" @click="editingDsn = true">
            Change connection string
          </Button>

          <AssignConnectionDialog :id="id" kind="postgres" />

          <DeleteConnectionDialog :id="id" :label="data?.instance.label" kind="postgres" />
        </div>
      </section>
    </template>

  </div>
</template>
