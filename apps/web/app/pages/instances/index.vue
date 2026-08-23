<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'

interface InstanceRow {
  id: string
  label: string
  state: ConnectionState
  profileName?: string
  number?: string
  stats: { messages: number, chats: number, contacts: number }
}

const { data, status } = await useFetch<{ instances: InstanceRow[] }>('/api/instances')

// A fresh account has nothing to list, so send it straight to pairing — that is
// what makes signup land on a QR code.
if (status.value !== 'pending' && !data.value?.instances?.length) {
  await navigateTo('/instances/new', { replace: true })
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1 class="font-heading text-2xl font-semibold">
          WhatsApp accounts
        </h1>
        <p class="text-sm text-muted-foreground">
          Each connected account gets its own Claude connector.
        </p>
      </div>

      <Button as-child size="sm">
        <NuxtLink to="/instances/new">
          <PlusIcon class="size-4" />
          Connect a number
        </NuxtLink>
      </Button>
    </div>

    <div v-if="status === 'pending'" class="grid gap-4 sm:grid-cols-2">
      <Skeleton class="h-40" />
      <Skeleton class="h-40" />
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2">
      <InstanceCard
        v-for="instance in data?.instances ?? []"
        :key="instance.id"
        :instance="instance"
      />
    </div>
  </div>
</template>
