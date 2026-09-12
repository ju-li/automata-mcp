<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'

const { isAdmin } = useSession()

const { data, status } = await useFetch<{ instances: InstanceListRow[] }>('/api/instances')

const empty = computed(() => status.value !== 'pending' && !data.value?.instances?.length)

// A fresh organization has nothing to list, so send its admin straight to the
// create flow — that is what makes signup land somewhere useful rather than on
// an empty page. A member cannot create anything, so for them an empty list is
// the real answer and the redirect would be a dead end.
if (empty.value && isAdmin.value) {
  await navigateTo('/instances/new', { replace: true })
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
            : 'The connections assigned to you. Each one gets its own Claude connector.' }}
        </p>
      </div>

      <Button v-if="isAdmin" as-child size="sm">
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
          Nothing has been assigned to you. An admin of your organization can
          give you access to a connection.
        </CardDescription>
      </CardHeader>
    </Card>

    <div v-else class="grid gap-4 sm:grid-cols-2">
      <InstanceCard
        v-for="instance in data?.instances ?? []"
        :key="instance.id"
        :instance="instance"
      />
    </div>
  </div>
</template>
