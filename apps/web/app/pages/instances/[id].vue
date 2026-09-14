<script setup lang="ts">
/**
 * Which panel a connection gets is decided by its kind, and nothing else on
 * this page knows anything about either kind.
 *
 * The summary fetch is deliberately the cheap one — a PocketBase read with no
 * Evolution call and no database connection — because the panel it chooses then
 * makes the expensive one itself. Deciding here from a full status fetch would
 * mean two of those.
 */
const route = useRoute()
const id = computed(() => route.params.id as string)

const { data, error } = await useFetch<{ instance: PublicInstanceRow, canManage: boolean }>(
  () => `/api/instances/${id.value}/summary`,
)

const kind = computed(() => data.value?.instance.kind)

// Decided by the server and carried on the summary this page already fetches,
// rather than recomputed from the session role — one rule, one place, the same
// argument `canReadMessages` makes. It gates presentation only: every control it
// hides is independently refused with a 403.
const canManage = computed(() => data.value?.canManage === true)
</script>

<template>
  <div>
    <p v-if="error" class="text-sm text-muted-foreground">
      This connection could not be loaded. It may have been removed.
    </p>

    <InstancePostgres v-else-if="kind === 'postgres'" :id="id" :can-manage="canManage" />
    <InstanceWhatsapp v-else-if="kind === 'whatsapp'" :id="id" :can-manage="canManage" />
    <InstanceTelegram v-else-if="kind === 'telegram'" :id="id" :can-manage="canManage" />
    <!-- A kind with no panel in this build. Said out loud rather than rendering
         an empty page, which reads as a load that never finished. -->
    <p v-else-if="data" class="text-sm text-muted-foreground">
      This kind of connection is not supported by this version of the app yet.
    </p>
  </div>
</template>
