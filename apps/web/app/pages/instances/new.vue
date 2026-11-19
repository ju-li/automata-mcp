<script setup lang="ts">
/**
 * Add a connection: the picker and the chosen kind's form
 * (ConnectionCreateForm), then on to the new connection's page, where pairing
 * and tokens live.
 */
const kind = ref<InstanceKind | undefined>()

async function opened(instance: { id: string }) {
  await navigateTo(`/instances/${instance.id}`)
}
</script>

<template>
  <!--
    The picker takes the layout's full width so its cards sit in a grid; the
    form for a chosen kind is a single column of inputs and stays narrow.
  -->
  <div class="mx-auto space-y-6" :class="kind ? 'max-w-md' : 'max-w-5xl'">
    <div>
      <h1 class="font-heading text-2xl font-semibold">
        Add a connection
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Each connection gets its own Claude connector, and each connector token
        reaches exactly one connection.
      </p>
    </div>

    <ConnectionCreateForm v-model:kind="kind" @created="opened" />
  </div>
</template>
