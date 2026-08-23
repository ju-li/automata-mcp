<script setup lang="ts">
defineProps<{ label: string, value: number }>()

const format = new Intl.NumberFormat()
</script>

<template>
  <Card>
    <CardContent class="pt-6">
      <p class="text-sm text-muted-foreground">
        {{ label }}
      </p>
      <p class="mt-1 font-heading text-3xl font-semibold tabular-nums">
        {{ format.format(value) }}
      </p>
    </CardContent>
  </Card>
</template>
