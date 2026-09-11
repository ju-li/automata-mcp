<script setup lang="ts">
import { DatabaseIcon, MessageCircleIcon } from '@lucide/vue'

/**
 * One connection in the listing.
 *
 * The secondary line and the footer say different things per kind because the
 * facts are different: a WhatsApp account has a profile and message counts, a
 * database has a host and a server version. Rendering a zeroed message count for
 * a database would suggest it has messages.
 */
const props = defineProps<{ instance: InstanceListRow }>()

const isPostgres = computed(() => props.instance.kind === 'postgres')

const secondary = computed(() => {
  if (isPostgres.value) return props.instance.target || 'No connection string stored'
  return props.instance.profileName || props.instance.number || 'Not paired yet'
})
</script>

<template>
  <NuxtLink :to="`/instances/${instance.id}`" class="block">
    <Card class="transition-colors hover:border-foreground/20">
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <CardTitle class="flex items-center gap-2 truncate">
              <DatabaseIcon v-if="isPostgres" class="size-4 shrink-0 text-muted-foreground" />
              <MessageCircleIcon v-else class="size-4 shrink-0 text-muted-foreground" />
              {{ instance.label }}
            </CardTitle>
            <CardDescription class="truncate" :class="isPostgres && 'font-mono text-xs'">
              {{ secondary }}
            </CardDescription>
          </div>
          <ConnectionBadge :state="instance.state" :kind="instance.kind" :lost="instance.sessionLost" />
        </div>
      </CardHeader>
      <CardContent>
        <p v-if="isPostgres" class="truncate text-sm text-muted-foreground">
          {{ instance.detail || 'PostgreSQL' }}
        </p>
        <p v-else class="text-sm text-muted-foreground tabular-nums">
          {{ instance.stats?.messages ?? 0 }} messages · {{ instance.stats?.chats ?? 0 }} chats
        </p>
      </CardContent>
    </Card>
  </NuxtLink>
</template>
