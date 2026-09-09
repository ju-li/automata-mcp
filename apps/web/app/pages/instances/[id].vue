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

const { data, error } = await useFetch<{ instance: PublicInstanceRow }>(
  () => `/api/instances/${id.value}/summary`,
)

const kind = computed(() => data.value?.instance.kind)
</script>

<template>
  <div>
    <p v-if="error" class="text-sm text-muted-foreground">
      This connection could not be loaded. It may have been removed.
    </p>

    <InstancePostgres v-else-if="kind === 'postgres'" :id="id" />
    <InstanceWhatsapp v-else-if="kind === 'whatsapp'" :id="id" />
  </div>
</template>
