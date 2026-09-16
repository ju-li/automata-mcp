<script setup lang="ts">
import { CheckIcon, PencilIcon, XIcon } from '@lucide/vue'

/**
 * The connection's name, and the one control that changes it.
 *
 * All three panels render a byte-identical title block, so the rename lives here
 * once rather than as three copies of the same four pieces of state — the same
 * argument `ConnectionBadge` already makes for the badge beside it.
 *
 * What is edited is `label`, the nickname. `instances.name` is the Evolution
 * instance name and the Telegram bridge session name and is not editable by
 * anyone; see `server/api/instances/[id]/label.patch.ts`.
 *
 * The subtitle stays in the panels: it is the one line of that block that
 * genuinely differs per kind, and pulling it in here would mean branching on
 * kind inside a shared component.
 */
const props = withDefaults(defineProps<{
  id: string
  label?: string
  /**
   * Whether this viewer may rename the connection. Presentation only — the
   * route refuses a member with a 403 regardless of what is rendered.
   */
  canManage?: boolean
}>(), { canManage: false })

const emit = defineEmits<{ renamed: [] }>()

const editing = ref(false)
const draft = ref('')
const inputRef = ref<ComponentPublicInstance | null>(null)

const { busy, run } = useApiAction()

async function start() {
  draft.value = props.label ?? ''
  editing.value = true
  // The field is created by the `v-if` in this same tick, so it cannot be
  // focused until it exists.
  await nextTick()
  const el = inputRef.value?.$el as HTMLInputElement | undefined
  el?.focus()
  el?.select()
}

async function save() {
  const label = draft.value.trim()
  if (!label) return

  // Closing the editor is the whole action when nothing was typed. A write here
  // would toast "Connection renamed" over a name that did not change, which
  // reads as a change that silently went somewhere else.
  if (label === props.label) {
    editing.value = false
    return
  }

  await run(async () => {
    await $fetch(`/api/instances/${props.id}/label`, { method: 'PATCH', body: { label } })
    editing.value = false
    emit('renamed')
  }, { success: 'Connection renamed.', failure: 'Could not rename the connection' })
}
</script>

<template>
  <div v-if="editing" class="flex items-center gap-2">
    <Input
      ref="inputRef"
      v-model="draft"
      class="max-w-sm"
      maxlength="100"
      aria-label="Connection name"
      :disabled="busy"
      @keyup.enter="save()"
      @keyup.esc="editing = false"
    />
    <Button size="icon-sm" :disabled="busy || !draft.trim()" aria-label="Save name" @click="save()">
      <CheckIcon class="size-4" />
    </Button>
    <Button size="icon-sm" variant="ghost" :disabled="busy" aria-label="Cancel" @click="editing = false">
      <XIcon class="size-4" />
    </Button>
  </div>

  <div v-else class="flex min-w-0 items-center gap-1">
    <h1 class="truncate font-heading text-2xl font-semibold">
      {{ label }}
    </h1>
    <!--
      Revealed by hovering the title bar, and three things about that are load
      bearing. The button is always in the DOM — hidden with `opacity-0` rather
      than `v-if` — or it could not be reached by Tab, and `group-focus-within`
      would have nothing to reveal. `[@media(hover:none)]` puts it back
      permanently on a touch device, which never hovers and would otherwise have
      no way to rename anything at all. And the group is named, so a `group` a
      panel adds around this later cannot capture it.
    -->
    <Button
      v-if="canManage"
      size="icon-sm"
      variant="ghost"
      class="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      aria-label="Rename this connection"
      @click="start()"
    >
      <PencilIcon class="size-4" />
    </Button>
  </div>
</template>
