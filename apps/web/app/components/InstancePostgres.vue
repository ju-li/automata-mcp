<script setup lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import { ArrowLeftIcon, DatabaseIcon, TableIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * The dashboard for a database connection.
 *
 * Deliberately not a re-skin of the WhatsApp panel: there is no pairing, no
 * profile and no message count, and rendering an empty version of any of those
 * would suggest a state this connection can be in. What it does have is a health
 * check, the tables it can reach, and the two things an owner needs — rotate the
 * connection string, remove the connection.
 */
const props = defineProps<{ id: string }>()

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
}>(() => `/api/instances/${id.value}/tables`, { lazy: true, query: { limit: 200 } })

const state = computed<ConnectionState>(() => data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')
const tablesLoading = computed(() => tableStatus.value === 'idle' || tableStatus.value === 'pending')

const busy = ref(false)
const deleteConfirm = ref('')
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
  busy.value = true
  try {
    await $fetch(`/api/instances/${id.value}/dsn`, {
      method: 'PATCH',
      body: { dsn: newDsn.value.trim() },
    })
    newDsn.value = ''
    editingDsn.value = false
    await refresh()
    await refreshTables()
    toast.success('Connection string updated. Existing tokens keep working.')
  }
  catch (err: any) {
    toast.error(apiErrorMessage(err, 'Could not update the connection string'))
  }
  finally {
    busy.value = false
  }
}

async function destroy() {
  busy.value = true
  try {
    await $fetch(`/api/instances/${id.value}`, { method: 'DELETE' })
    toast.success('Connection removed')
    await navigateTo('/instances')
  }
  catch {
    toast.error('Could not remove the connection')
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <NuxtLink to="/instances" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon class="size-4" />
        All connections
      </NuxtLink>

      <div class="mt-2 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="truncate font-heading text-2xl font-semibold">
            {{ data?.instance.label }}
          </h1>
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
        <p v-if="tableData?.tables?.length" class="text-sm text-muted-foreground">
          {{ tableData.tables.length }}{{ tableData.hasMore ? '+' : '' }} reachable
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

      <div v-else class="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Table</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead class="text-right">
                Rows (estimate)
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="table in tableData.tables" :key="table.qname">
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

      <p v-if="tableData?.hasMore" class="text-xs text-muted-foreground">
        More tables exist than are shown here.
      </p>
    </section>

    <Separator />

    <!--
      Always shown, including while the database is unreachable. Hiding it would
      mean you could not revoke a token for a connection that is down — which is
      exactly when you would want to.
    -->
    <McpTokens :instance-id="id" kind="postgres" :connected="connected" />

    <Separator />

    <!-- ── controls ────────────────────────────────────────────────────── -->
    <section class="space-y-4">
      <h2 class="font-heading text-lg font-semibold">
        Manage
      </h2>

      <div v-if="editingDsn" class="max-w-xl space-y-2 rounded-md border p-4">
        <Label for="new-dsn">New connection string</Label>
        <Input
          id="new-dsn"
          v-model="newDsn"
          autocomplete="off"
          spellcheck="false"
          placeholder="postgres://user:password@host:5432/database"
        />
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

        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button variant="destructive" :disabled="busy">
              Remove connection
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove “{{ data?.instance.label }}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes the stored connection string and every connector token
                issued for it, and Claude immediately loses access. Your database
                and its data are not touched. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div class="space-y-2">
              <Label for="confirm">Type <span class="font-mono">delete</span> to confirm</Label>
              <Input id="confirm" v-model="deleteConfirm" autocomplete="off" />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel @click="deleteConfirm = ''">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                :disabled="deleteConfirm !== 'delete' || busy"
                @click="destroy"
              >
                Remove permanently
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  </div>
</template>
