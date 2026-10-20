<script setup lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import { FolderIcon, MailIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * The dashboard for a mailbox.
 *
 * Built like the database panel, not the messaging ones: there is no pairing
 * and no profile. What it has is the sync's state, the folders with how much of
 * each is synced, and the owner's controls — change the credentials, sync now,
 * remove the connection.
 *
 * The health shown is the sync's last outcome, not a login made for this page
 * (see `getImapHealth`), so polling it costs the mail server nothing.
 */
const props = withDefaults(defineProps<{
  id: string
  /** Decided by the server; gates presentation only — every hidden control is refused with a 403. */
  canManage?: boolean
}>(), { canManage: false })

interface StatusResponse {
  instance: PublicInstanceRow
  state: ConnectionState
  detail?: string
  error?: string
}

interface MailFolderRow {
  path: string
  name: string
  specialUse?: string
  synced: boolean
  serverMessages?: number
  syncedMessages: number
  unread: number
  lastSyncedAt?: string
  history: { complete: boolean, stopped?: 'days' | 'count', oldestSyncedAt?: string }
}

interface MailboxResponse {
  sync?: { lastAttemptAt?: string, lastSuccessAt?: string, lastError?: string, authFailed: boolean }
  folders: MailFolderRow[]
  limits: { days: number, max: number }
}

const id = computed(() => props.id)

const { data, refresh } = await useFetch<StatusResponse>(() => `/api/instances/${id.value}`)
const { data: mailbox, refresh: refreshMailbox } = await useFetch<MailboxResponse>(
  () => `/api/instances/${id.value}/imap`,
  { lazy: true },
)

const state = computed<ConnectionState>(() => data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')

const syncedFolders = computed(() => (mailbox.value?.folders ?? []).filter(f => f.synced))
const totalSynced = computed(() => syncedFolders.value.reduce((sum, f) => sum + f.syncedMessages, 0))
const backfilling = computed(() => syncedFolders.value.some(f => !f.history.complete && !f.history.stopped))

// A database read on our side only, so a steadier poll than Postgres' is fine;
// still paused behind a hidden tab.
const visibility = useDocumentVisibility()
useIntervalFn(() => {
  if (visibility.value === 'hidden') return
  refresh()
  refreshMailbox()
}, 15_000)

function folderProgress(folder: MailFolderRow): string {
  if (!folder.synced) return 'Not synced'
  const synced = folder.syncedMessages.toLocaleString()
  if (folder.history.complete) return `${synced} synced`
  if (folder.history.stopped === 'days') return `${synced} synced · older than ${mailbox.value?.limits.days} days skipped`
  if (folder.history.stopped === 'count') return `${synced} synced · limit reached`
  const total = folder.serverMessages === undefined ? '' : ` of ~${folder.serverMessages.toLocaleString()}`
  return `${synced}${total} synced · syncing older mail`
}

function ago(iso: string | undefined): string {
  if (!iso) return 'never'
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

const { busy, run } = useApiAction()
const editing = ref(false)
const credentials = ref<ImapCredentials>(emptyImapCredentials())

async function saveCredentials() {
  const body = imapCredentialsBody(credentials.value)
  if (!body) return
  await run(
    async () => {
      await $fetch(`/api/instances/${id.value}/imap`, { method: 'PATCH', body })
      credentials.value = emptyImapCredentials()
      editing.value = false
      await refresh()
      await refreshMailbox()
    },
    {
      success: 'Credentials updated. Existing tokens keep working.',
      // The server's message says what the mail server refused.
      failure: 'Could not update the credentials',
    },
  )
}

async function syncNow() {
  const result = await run(
    () => $fetch<{ started: boolean }>(`/api/instances/${id.value}/imap/sync`, { method: 'POST' }),
    { failure: 'Could not start a sync' },
  )
  if (!result) return
  // Not started means another run holds the mailbox — already doing the work.
  toast.success(result.started ? 'Sync started.' : 'A sync is already running for this mailbox.')
  setTimeout(() => {
    refresh()
    refreshMailbox()
  }, 3000)
}
</script>

<template>
  <div class="space-y-8">
    <InstanceHeader
      :id="id"
      :label="data?.instance.label"
      :can-manage="canManage"
      :state="state"
      kind="imap"
      @renamed="refresh()"
    >
      <p class="truncate font-mono text-sm text-muted-foreground">
        {{ data?.instance.target || 'No credentials stored' }}
      </p>
    </InstanceHeader>

    <!-- ── sync ────────────────────────────────────────────────────────── -->
    <Card>
      <CardContent class="flex items-start gap-3 pt-6">
        <MailIcon class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 space-y-1">
          <template v-if="data?.error">
            <p class="text-sm font-medium">
              Sync failing
            </p>
            <p class="text-sm text-muted-foreground">
              {{ data.error }}
            </p>
          </template>
          <p v-else class="text-sm font-medium">
            {{ data?.detail || 'Waiting for the first sync' }}
          </p>
          <p class="text-sm text-muted-foreground tabular-nums">
            {{ totalSynced.toLocaleString() }} emails in {{ syncedFolders.length }} folders
            <!-- The healthy line above already says when; a failing one does not. -->
            <template v-if="data?.error">
              · last synced {{ ago(mailbox?.sync?.lastSuccessAt) }}
            </template>
            <template v-if="backfilling">
              · older mail still syncing
            </template>
          </p>
          <p class="text-xs text-muted-foreground">
            Headers sync every two minutes, going back up to {{ mailbox?.limits.days ?? 365 }} days.
            Message bodies and attachments stay on your mail server and are fetched only when
            Claude asks for them.
          </p>
        </div>
      </CardContent>
    </Card>

    <!-- ── folders ─────────────────────────────────────────────────────── -->
    <section class="space-y-3">
      <h2 class="font-heading text-lg font-semibold">
        Folders
      </h2>
      <p class="text-sm text-muted-foreground">
        A connector token can be limited to some of these when you create it.
        All Mail, Junk and Trash are not synced.
      </p>

      <div v-if="!mailbox" class="space-y-2">
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-full" />
      </div>

      <p v-else-if="!mailbox.folders.length" class="rounded-md border p-4 text-sm text-muted-foreground">
        No folders yet. They appear after the first sync, a minute or two after the
        mailbox is connected.
      </p>

      <div v-else class="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Folder</TableHead>
              <TableHead class="text-right">
                Unread
              </TableHead>
              <TableHead>Synced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="folder in mailbox.folders" :key="folder.path" :class="!folder.synced && 'opacity-60'">
              <TableCell class="text-sm">
                <div class="flex items-center gap-2">
                  <FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{{ folder.path }}</span>
                </div>
              </TableCell>
              <TableCell class="text-right text-sm tabular-nums text-muted-foreground">
                {{ folder.synced ? folder.unread.toLocaleString() : '—' }}
              </TableCell>
              <TableCell class="text-sm tabular-nums text-muted-foreground">
                {{ folderProgress(folder) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>

    <Separator />

    <!-- Always shown, so a token can be revoked while the mailbox is failing. -->
    <McpTokens
      :instance-id="id"
      kind="imap"
      :connected="connected"
      :can-manage="canManage"
    />

    <template v-if="canManage">
      <Separator />

      <!-- ── controls ──────────────────────────────────────────────────── -->
      <section class="space-y-4">
        <h2 class="font-heading text-lg font-semibold">
          Manage
        </h2>

        <div v-if="editing" class="max-w-xl space-y-2 rounded-md border p-4">
          <ImapCredentialsInput v-model="credentials" id-prefix="new-imap" />
          <p class="text-xs text-muted-foreground">
            Checked by logging in before it is saved. Every connector token keeps
            working. If this is a different mailbox, everything synced from the old
            one is deleted.
          </p>
          <div class="flex gap-2 pt-1">
            <Button :disabled="busy || !imapCredentialsBody(credentials)" @click="saveCredentials">
              {{ busy ? 'Checking…' : 'Save' }}
            </Button>
            <Button variant="ghost" :disabled="busy" @click="editing = false; credentials = emptyImapCredentials()">
              Cancel
            </Button>
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <Button v-if="!editing" variant="outline" :disabled="busy" @click="editing = true">
            Change credentials
          </Button>
          <Button variant="outline" :disabled="busy" @click="syncNow">
            Sync now
          </Button>

          <AssignConnectionDialog :id="id" kind="imap" />

          <DeleteConnectionDialog :id="id" :label="data?.instance.label" kind="imap" />
        </div>
      </section>
    </template>
  </div>
</template>
