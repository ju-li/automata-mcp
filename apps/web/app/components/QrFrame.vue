<script setup lang="ts">
import { SmartphoneIcon } from '@lucide/vue'

/**
 * The white square a pairing QR code sits in. A skeleton while the first code
 * is on its way, and an icon once the code has expired and none is coming.
 */
defineProps<{
  src?: string
  alt: string
  expired?: boolean
}>()
</script>

<template>
  <div class="flex size-64 items-center justify-center rounded-lg border bg-white p-2">
    <img v-if="src" :src="src" :alt="alt" class="size-full">
    <Skeleton v-else-if="!expired" class="size-full" />
    <SmartphoneIcon v-else class="size-10 text-muted-foreground" />
  </div>
</template>
