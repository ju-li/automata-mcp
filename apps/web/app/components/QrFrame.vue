<script setup lang="ts">
import { Loader2Icon, SmartphoneIcon } from '@lucide/vue'

/**
 * The white square a pairing QR code sits in. A skeleton while the first code
 * is on its way, and an icon once the code has expired and none is coming.
 *
 * `waiting` replaces the bare skeleton with a spinner and a sentence, for
 * callers whose code can take long enough that an empty grey square reads as
 * broken — WhatsApp after a sign-out, which waits on Evolution.
 */
defineProps<{
  src?: string
  alt: string
  expired?: boolean
  waiting?: string
}>()
</script>

<template>
  <div class="flex size-64 items-center justify-center rounded-lg border bg-white p-2">
    <img v-if="src" :src="src" :alt="alt" class="size-full">
    <SmartphoneIcon v-else-if="expired" class="size-10 text-muted-foreground" />
    <div
      v-else-if="waiting"
      role="status"
      class="flex flex-col items-center gap-3 px-6 text-center text-sm text-neutral-500"
    >
      <Loader2Icon class="size-8 animate-spin" />
      <p>{{ waiting }}</p>
    </div>
    <Skeleton v-else class="size-full" />
  </div>
</template>
