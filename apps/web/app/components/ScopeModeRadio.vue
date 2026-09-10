<script setup lang="ts">
/**
 * "All of this axis" versus "only what I pick", for one scope axis.
 *
 * The tools, tables and chats axes each had their own copy of this radio pair,
 * identical but for the two labels and the ids. Same reason `toggle(key, value,
 * on)` in `TokenScopeFields.vue` is one function rather than three: the logic is
 * a single boolean, and three copies of it are three places to fix a keyboard or
 * labelling bug.
 *
 * The value is the axis's `all_*` flag, so `true` is the open default — see
 * `openScope()`.
 */
const open = defineModel<boolean>({ required: true })

defineProps<{
  /** Used for the input ids and their labels' `for`, so it must be unique on the page. */
  name: string
  allLabel: string
  someLabel: string
}>()
</script>

<template>
  <RadioGroup
    :model-value="open ? 'all' : 'some'"
    @update:model-value="open = $event === 'all'"
  >
    <div class="flex items-center gap-2">
      <RadioGroupItem :id="`${name}-all`" value="all" />
      <Label :for="`${name}-all`" class="font-normal">{{ allLabel }}</Label>
    </div>
    <div class="flex items-center gap-2">
      <RadioGroupItem :id="`${name}-some`" value="some" />
      <Label :for="`${name}-some`" class="font-normal">{{ someLabel }}</Label>
    </div>
  </RadioGroup>
</template>
