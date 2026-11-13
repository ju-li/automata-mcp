<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'

const { user, isAdmin, canCreateConnections } = useSession()

const { data, status } = await useFetch<{ instances: InstanceListRow[] }>('/api/instances')

const empty = computed(() => status.value !== 'pending' && !data.value?.instances?.length)

// A fresh organization has nothing to list, so send its admin straight to the
// create flow — that is what makes signup land somewhere useful rather than on
// an empty page. A member is not redirected: they usually joined to use what a
// colleague will assign them, so the empty state offers both paths instead —
// or only the second, where the organization lets only admins add connections.
if (empty.value && isAdmin.value) {
  await navigateTo('/instances/new', { replace: true })
}

// ── filters ─────────────────────────────────────────────────────────────────
// Filtered in the browser on purpose: this listing is never paged — the server
// returns every connection the viewer reaches, with live state — so the rows
// here are the whole answer, not a page of it. Options come from the rows, so
// a filter never offers a value that matches nothing.

const ANY = 'any'
const FORMER = 'former'
const UNRECORDED = 'unrecorded'

const kindFilter = ref<string>(ANY)
const creatorFilter = ref<string>(ANY)

const instances = computed(() => data.value?.instances ?? [])

function kindTitle(kind: InstanceKind): string {
  const words = describeKind(kind)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const kindOptions = computed(() => {
  const kinds = [...new Set(instances.value.map(row => row.kind))]
  return kinds.map(kind => ({ value: kind, label: kindTitle(kind) }))
    .sort((a, b) => a.label.localeCompare(b.label))
})

/** The filter key a row's creator falls under. */
function creatorKey(row: InstanceListRow): string {
  if (!row.createdBy) return UNRECORDED
  if (row.createdBy.former) return FORMER
  return row.createdBy.id
}

const creatorOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const row of instances.value) {
    const key = creatorKey(row)
    if (seen.has(key)) continue
    seen.set(key, key === UNRECORDED
      ? 'Not recorded'
      : key === FORMER
        ? 'Former members'
        : key === user.value?.id ? 'You' : creatorLabel(row.createdBy, user.value?.id) ?? 'Unknown')
  }
  // You first, then people by name, then the two catch-alls.
  const rank = (key: string) => key === user.value?.id ? 0 : key === FORMER ? 2 : key === UNRECORDED ? 3 : 1
  return [...seen].map(([value, label]) => ({ value, label }))
    .sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label))
})

// The creator filter shows whenever the bar does, even when everything here was
// added by one person: an absent control reads as "this page can't filter by
// creator", not as "there is only one creator".
const showFilters = computed(() => kindOptions.value.length > 1 || creatorOptions.value.length > 1)

const filtered = computed(() => instances.value.filter(row =>
  (kindFilter.value === ANY || row.kind === kindFilter.value)
  && (creatorFilter.value === ANY || creatorKey(row) === creatorFilter.value),
))

function clearFilters() {
  kindFilter.value = ANY
  creatorFilter.value = ANY
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1 class="font-heading text-2xl font-semibold">
          Connections
        </h1>
        <p class="text-sm text-muted-foreground">
          {{ isAdmin
            ? 'Each connection gets its own Claude connector.'
            : 'The connections you created or were assigned. Each one gets its own Claude connector.' }}
        </p>
      </div>

      <Button v-if="canCreateConnections" as-child size="sm">
        <NuxtLink to="/instances/new">
          <PlusIcon class="size-4" />
          Add a connection
        </NuxtLink>
      </Button>
    </div>

    <div v-if="status === 'pending'" class="grid gap-4 sm:grid-cols-2">
      <Skeleton class="h-40" />
      <Skeleton class="h-40" />
    </div>

    <!-- Only a member ever sees this: an admin with nothing was redirected to
         the create flow before the page rendered. -->
    <Card v-else-if="empty">
      <CardHeader>
        <CardTitle>No connections yet</CardTitle>
        <CardDescription>
          <template v-if="canCreateConnections">
            Nothing has been assigned to you yet. Add a connection of your own, or
            ask an admin of your organization to give you access to one.
          </template>
          <template v-else>
            Nothing has been assigned to you. An admin of your organization can
            give you access to a connection.
          </template>
        </CardDescription>
      </CardHeader>
    </Card>

    <template v-else>
      <div v-if="showFilters" class="flex flex-wrap items-center gap-2">
        <Select v-if="kindOptions.length > 1" v-model="kindFilter">
          <SelectTrigger class="w-full sm:w-48" aria-label="Filter by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ANY">
              All types
            </SelectItem>
            <SelectItem v-for="option in kindOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>

        <Select v-model="creatorFilter">
          <SelectTrigger class="w-full sm:w-56" aria-label="Filter by who added it">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ANY">
              Added by anyone
            </SelectItem>
            <SelectItem v-for="option in creatorOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>

        <Button
          v-if="kindFilter !== ANY || creatorFilter !== ANY"
          variant="ghost"
          size="sm"
          @click="clearFilters()"
        >
          Clear filters
        </Button>
      </div>

      <p v-if="!filtered.length" class="text-sm text-muted-foreground">
        No connections match these filters.
      </p>

      <div v-else class="grid gap-4 sm:grid-cols-2">
        <InstanceCard
          v-for="instance in filtered"
          :key="instance.id"
          :instance="instance"
        />
      </div>
    </template>
  </div>
</template>
