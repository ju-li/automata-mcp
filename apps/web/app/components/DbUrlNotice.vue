<script setup lang="ts">
import { assertNever } from '#shared/connection'

/**
 * Shown only for an account on the user's own server that has no database URL
 * yet. Reading goes to that server's own Postgres, so it is the one capability
 * missing, and it is not obvious why — so this says what and why rather than
 * just offering a field. Otherwise the first sign of it is a tool returning 501
 * mid-conversation.
 */
const props = defineProps<{
  id: string
  kind: Extract<InstanceKind, 'whatsapp' | 'telegram'>
}>()

const emit = defineEmits<{ saved: [] }>()

const copy = computed(() => {
  switch (props.kind) {
    case 'whatsapp':
      return {
        path: 'evolution-db',
        title: 'Claude cannot read this account\'s messages yet',
        description: 'Reading and searching go to your Evolution server\'s own Postgres, because Evolution\'s API cannot search message content. This app has the server\'s URL but not its database. Pairing, listing chats and sending already work.',
        placeholder: 'postgres://reader:password@host:5432/evolution',
        success: 'Claude can now read and search this account\'s messages.',
        // Split around the one word set in monospace.
        help: ['Checked against your database before it is saved. A ', 'SELECT', '-only role is enough — this app never writes to it.'],
      }
    case 'telegram':
      return {
        path: 'telegram-db',
        title: 'Claude cannot read this account\'s chats yet',
        description: 'Reading and searching go to your Telegram bridge\'s database. This app has the bridge\'s URL but not its database. Linking and sending already work.',
        placeholder: 'postgresql://user:password@host:5432/database',
        success: 'Claude can now read and search this account\'s chats.',
        help: ['Checked against the bridge\'s ', 'telegram', ' schema before it is saved.'],
      }
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

const dbUrl = ref('')
const { busy, run } = useApiAction()

async function save() {
  if (!dbUrl.value.trim()) return

  await run(
    async () => {
      await $fetch(`/api/instances/${props.id}/${copy.value.path}`, {
        method: 'PATCH',
        body: { dbUrl: dbUrl.value.trim() },
      })
      dbUrl.value = ''
      emit('saved')
    },
    {
      success: copy.value.success,
      // The server's message names the actual failure — wrong database, refused
      // host, missing SELECT — so it is worth more than a generic here.
      failure: 'Could not save the database connection string',
    },
  )
}
</script>

<template>
  <NoticeCard :title="copy.title">
    <template #description>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ copy.description }}
      </p>
    </template>

    <div class="space-y-2">
      <Label :for="`db-url-${id}`">Database connection string</Label>
      <Input
        :id="`db-url-${id}`"
        v-model="dbUrl"
        autocomplete="off"
        spellcheck="false"
        :placeholder="copy.placeholder"
        @keydown.enter="save"
      />
      <p class="text-xs text-muted-foreground">
        {{ copy.help[0] }}<span class="font-mono">{{ copy.help[1] }}</span>{{ copy.help[2] }}
      </p>
    </div>

    <Button size="sm" :disabled="busy || !dbUrl.trim()" @click="save">
      {{ busy ? 'Checking…' : 'Enable reading' }}
    </Button>
  </NoticeCard>
</template>
