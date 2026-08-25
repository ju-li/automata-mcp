<script setup lang="ts">
import { PlusIcon, SearchIcon, UsersIcon, XIcon } from '@lucide/vue'

/**
 * The scope editor, shared by the create and edit dialogs so the two cannot
 * drift into disagreeing about what a scope is.
 */
const props = defineProps<{ instanceId: string }>()
const scope = defineModel<TokenScope>({ required: true })

const { data: toolData } = await useFetch<{ tools: McpToolInfo[] }>('/api/mcp/tools')
const { data: chatData, status: chatStatus } = await useFetch<{ chats: ScopedChat[] }>(
  () => `/api/instances/${props.instanceId}/chats`,
)

// Chats picked by JID may not be in the fetched list — a number added by hand,
// or one whose conversation has since aged out. Keep our own record of them so
// the selection can always be rendered with a name.
const extraChats = ref<ScopedChat[]>([])
const search = ref('')
const manualNumber = ref('')
const resolving = ref(false)
const manualError = ref('')

const knownChats = computed<ScopedChat[]>(() => {
  const seen = new Map<string, ScopedChat>()
  for (const chat of [...(chatData.value?.chats ?? []), ...extraChats.value]) {
    if (!seen.has(chat.jid)) seen.set(chat.jid, chat)
  }
  return [...seen.values()]
})

const visibleChats = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return knownChats.value
  return knownChats.value.filter(c =>
    c.name.toLowerCase().includes(q) || c.jid.toLowerCase().includes(q),
  )
})

const selectedChats = computed(() =>
  scope.value.chat_jids.map(jid =>
    knownChats.value.find(c => c.jid === jid) ?? { jid, name: jid.split('@')[0]! },
  ),
)

function toggleTool(name: string, on: boolean) {
  const next = new Set(scope.value.tool_names)
  on ? next.add(name) : next.delete(name)
  scope.value = { ...scope.value, tool_names: [...next] }
}

/**
 * The muted line under a chat's name: a number for a person, a size for a group.
 * Two chats can share a display name, and this is what tells them apart.
 *
 * Digits only, deliberately. Formatting a number for reading needs
 * country-specific rules, and this app never applies those locally.
 */
function secondaryLine(chat: ScopedChat): string {
  if (chat.isGroup) {
    if (!chat.participantCount) return ''
    return chat.participantCount === 1 ? '1 member' : `${chat.participantCount} members`
  }
  return chat.number ? `+${chat.number}` : ''
}

function toggleChat(jid: string, on: boolean) {
  const next = new Set(scope.value.chat_jids)
  on ? next.add(jid) : next.delete(jid)
  scope.value = { ...scope.value, chat_jids: [...next] }
}

async function addByNumber() {
  manualError.value = ''
  const number = manualNumber.value.trim()
  if (!number) return

  resolving.value = true
  try {
    const result = await $fetch<{ jid: string, name?: string }>(
      `/api/instances/${props.instanceId}/chats/resolve`,
      { method: 'POST', body: { number } },
    )
    if (!knownChats.value.some(c => c.jid === result.jid)) {
      // The number under the name comes off the resolved JID, not what was typed:
      // Evolution's rules may have rewritten it, and the JID is what scope matches.
      const resolvedNumber = result.jid.split('@')[0]!
      extraChats.value.push({
        jid: result.jid,
        name: result.name?.trim() || resolvedNumber,
        isGroup: false,
        number: resolvedNumber,
      })
    }
    toggleChat(result.jid, true)
    manualNumber.value = ''
  }
  catch (err: any) {
    manualError.value = err?.data?.statusMessage || err?.data?.message || 'Could not add that number'
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- ── actions ─────────────────────────────────────────────────────── -->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">
          Actions
        </h3>
        <p class="text-xs text-muted-foreground">
          What this token is allowed to do.
        </p>
      </div>

      <RadioGroup
        :model-value="scope.all_tools ? 'all' : 'some'"
        @update:model-value="scope = { ...scope, all_tools: $event === 'all' }"
      >
        <div class="flex items-center gap-2">
          <RadioGroupItem id="tools-all" value="all" />
          <Label for="tools-all" class="font-normal">All actions</Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem id="tools-some" value="some" />
          <Label for="tools-some" class="font-normal">Only selected actions</Label>
        </div>
      </RadioGroup>

      <div v-if="!scope.all_tools" class="space-y-2 rounded-md border p-3">
        <div
          v-for="tool in toolData?.tools ?? []"
          :key="tool.name"
          class="flex items-start gap-3"
        >
          <Checkbox
            :id="`tool-${tool.name}`"
            :model-value="scope.tool_names.includes(tool.name)"
            class="mt-0.5"
            @update:model-value="toggleTool(tool.name, $event === true)"
          />
          <div class="min-w-0">
            <Label :for="`tool-${tool.name}`" class="flex items-center gap-2 font-normal">
              {{ tool.title }}
              <Badge :variant="tool.readOnly ? 'secondary' : 'outline'" class="text-[10px]">
                {{ tool.readOnly ? 'read' : 'write' }}
              </Badge>
            </Label>
            <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {{ tool.description }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <Separator />

    <!-- ── chats ───────────────────────────────────────────────────────── -->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">
          Chats
        </h3>
        <p class="text-xs text-muted-foreground">
          Which conversations this token can read and reply in.
        </p>
      </div>

      <RadioGroup
        :model-value="scope.all_chats ? 'all' : 'some'"
        @update:model-value="scope = { ...scope, all_chats: $event === 'all' }"
      >
        <div class="flex items-center gap-2">
          <RadioGroupItem id="chats-all" value="all" />
          <Label for="chats-all" class="font-normal">All chats</Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem id="chats-some" value="some" />
          <Label for="chats-some" class="font-normal">Only selected chats</Label>
        </div>
      </RadioGroup>

      <div v-if="!scope.all_chats" class="space-y-3 rounded-md border p-3">
        <div v-if="selectedChats.length" class="flex flex-wrap gap-1.5">
          <Badge
            v-for="chat in selectedChats"
            :key="chat.jid"
            variant="secondary"
            class="gap-1"
          >
            {{ chat.name }}
            <button type="button" :aria-label="`Remove ${chat.name}`" @click="toggleChat(chat.jid, false)">
              <XIcon class="size-3" />
            </button>
          </Badge>
        </div>

        <div class="relative">
          <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" placeholder="Search conversations" class="pl-8" />
        </div>

        <div class="max-h-52 space-y-1 overflow-y-auto">
          <Skeleton v-if="chatStatus === 'pending'" class="h-16 w-full" />

          <p v-else-if="!knownChats.length" class="py-2 text-xs text-muted-foreground">
            No conversations recorded yet — they appear here once messages are
            exchanged. Add a number directly below.
          </p>

          <p v-else-if="!visibleChats.length" class="py-2 text-xs text-muted-foreground">
            Nothing matches “{{ search }}”.
          </p>

          <label
            v-for="chat in visibleChats"
            :key="chat.jid"
            class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
          >
            <Checkbox
              :model-value="scope.chat_jids.includes(chat.jid)"
              @update:model-value="toggleChat(chat.jid, $event === true)"
            />
            <img v-if="chat.profilePicUrl" :src="chat.profilePicUrl" alt="" class="size-8 rounded-full object-cover">
            <span v-else class="flex size-8 items-center justify-center rounded-full bg-muted">
              <UsersIcon v-if="chat.isGroup" class="size-3.5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ chat.name }}</span>
              <span
                v-if="secondaryLine(chat)"
                class="block truncate text-xs text-muted-foreground tabular-nums"
              >{{ secondaryLine(chat) }}</span>
            </span>
            <Badge v-if="chat.isGroup" variant="outline" class="text-[10px]">
              group
            </Badge>
          </label>
        </div>

        <div class="space-y-1 border-t pt-3">
          <Label for="manual-number" class="text-xs">Add by phone number</Label>
          <div class="flex gap-2">
            <Input
              id="manual-number"
              v-model="manualNumber"
              placeholder="5511999999999"
              class="min-w-0 flex-1"
              @keydown.enter.prevent="addByNumber"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              class="shrink-0"
              :disabled="resolving"
              aria-label="Add number"
              @click="addByNumber"
            >
              <PlusIcon class="size-4" />
            </Button>
          </div>
          <p v-if="manualError" class="text-xs text-destructive">
            {{ manualError }}
          </p>
          <p v-else class="text-xs text-muted-foreground">
            International format, no “+”. Checked against WhatsApp before it is added.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
