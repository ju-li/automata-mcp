<script setup lang="ts">
/**
 * An outline button that asks before it acts. The default slot is the
 * consequence, said in full — these end sessions on real accounts.
 */
defineProps<{
  label: string
  title: string
  confirmLabel: string
  disabled?: boolean
}>()

defineEmits<{ confirm: [] }>()
</script>

<template>
  <AlertDialog>
    <AlertDialogTrigger as-child>
      <Button variant="outline" :disabled="disabled">
        {{ label }}
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        <AlertDialogDescription>
          <slot />
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction @click="$emit('confirm')">
          {{ confirmLabel }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
