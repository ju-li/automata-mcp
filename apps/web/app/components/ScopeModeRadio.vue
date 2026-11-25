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
  /**
   * Check all / Uncheck all beside "only selected", shown while picking. What
   * they act on is the caller's decision (`bulkState()` in `TokenScopeFields`);
   * `filtered` only changes the hint, so the buttons can say a search narrows them.
   */
  bulk?: { canCheck: boolean, canUncheck: boolean, filtered: boolean }
}>()

const emit = defineEmits<{ bulk: [on: boolean] }>()
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
      <div v-if="bulk && !open" class="ml-auto flex shrink-0 gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          :disabled="!bulk.canCheck"
          :title="bulk.filtered ? 'Check every one matching the search' : undefined"
          @click="emit('bulk', true)"
        >
          Check all
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          :disabled="!bulk.canUncheck"
          :title="bulk.filtered ? 'Uncheck every one matching the search; others stay checked' : undefined"
          @click="emit('bulk', false)"
        >
          Uncheck all
        </Button>
      </div>
    </div>
  </RadioGroup>
</template>
