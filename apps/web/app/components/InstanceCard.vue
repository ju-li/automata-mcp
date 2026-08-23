<script setup lang="ts">
defineProps<{
  instance: {
    id: string
    label: string
    state: ConnectionState
    profileName?: string
    number?: string
    stats: { messages: number, chats: number, contacts: number }
  }
}>()
</script>

<template>
  <NuxtLink :to="`/instances/${instance.id}`" class="block">
    <Card class="transition-colors hover:border-foreground/20">
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <CardTitle class="truncate">
              {{ instance.label }}
            </CardTitle>
            <CardDescription class="truncate">
              {{ instance.profileName || instance.number || 'Not paired yet' }}
            </CardDescription>
          </div>
          <ConnectionBadge :state="instance.state" />
        </div>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-muted-foreground tabular-nums">
          {{ instance.stats.messages }} messages · {{ instance.stats.chats }} chats
        </p>
      </CardContent>
    </Card>
  </NuxtLink>
</template>
