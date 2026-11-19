<script setup lang="ts">
import type { Component } from 'vue'
import { BookUserIcon, MessageSquareTextIcon, MessagesSquareIcon, SendIcon, SmartphoneIcon } from '@lucide/vue'
import { useNow } from '@vueuse/core'
import { assertNever } from '#shared/connection'

/**
 * A messaging account at a glance, in one row: who it is, then its counts —
 * Messages, Chats and, where the kind keeps an address book, Contacts. Each
 * count opens the table behind it.
 *
 * Shared by WhatsApp and Telegram so the two dashboards cannot drift apart
 * again; what differs between them arrives as data, not as markup.
 */
const props = defineProps<{
  id: string
  kind: Extract<InstanceKind, 'whatsapp' | 'telegram'>
  profile: { name: string, detail: string, picUrl?: string }
  /**
   * Absent when the counts could not be measured in time; the cards then show a
   * dash rather than a 0 that reads as an empty account. `contacts` is absent
   * for a kind that keeps none. `asOf`: when they were counted — they are
   * cached, so the line under the cards says how old they are.
   */
  stats?: { messages: number, chats: number, contacts?: number, asOf?: string }
  /**
   * WhatsApp only: when the account last received a message (`at`), or that it
   * received none since `noneSince`. Absent: unknown, and nothing is said —
   * the counts are not offered as a stand-in, since they lag and count stored
   * rows rather than arrivals (#240).
   */
  lastReceived?: { at?: string, noneSince?: string }
  /**
   * Messages is clickable only where the table behind it can answer. Reading
   * goes to the backend's own database, and a connection that has not been
   * given one would open onto a guaranteed refusal — the same fact
   * `DbUrlNotice` explains at length.
   */
  canReadMessages: boolean
  /** Telegram only: passed to the chats table. See `ChatsDialog`'s prop. */
  moreHistory?: 'load' | 'upgrade' | 'view'
}>()

/** Stands in for a profile picture, which only WhatsApp provides. */
const fallbackIcon = computed<Component>(() => {
  switch (props.kind) {
    case 'whatsapp':
      return SmartphoneIcon
    case 'telegram':
      return SendIcon
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

/** From the kind, not from `stats`: missing counts must not remove the card. */
const hasContacts = computed(() => {
  switch (props.kind) {
    case 'whatsapp':
      return true
    case 'telegram':
      return false
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

/** Ticks so "14 min ago" keeps moving between status polls. */
const now = useNow({ interval: 30_000 })

const receivedLine = computed(() => {
  const received = props.lastReceived
  if (received?.at) return `Last message received ${timeAgo(received.at, now.value.getTime())}`
  if (received?.noneSince) return `No message received since ${formatDate(received.noneSince)}`
  return ''
})

const countsLine = computed(() =>
  props.stats?.asOf ? `Counts as of ${timeAgo(props.stats.asOf, now.value.getTime())}` : '')

const chatsOpen = ref(false)
const messagesOpen = ref(false)
const contactsOpen = ref(false)
</script>

<template>
  <!-- Full class strings rather than an interpolated count, so Tailwind sees them. -->
  <div class="grid gap-4 sm:grid-cols-2" :class="hasContacts ? 'lg:grid-cols-4' : 'lg:grid-cols-3'">
    <!-- The profile sits in the same row as the counts, so it stretches to
         their height and centres its contents rather than riding the top. -->
    <Card>
      <CardContent class="flex flex-1 items-center gap-4 pt-6">
        <img
          v-if="profile.picUrl"
          :src="profile.picUrl"
          alt=""
          class="size-12 shrink-0 rounded-full object-cover"
        >
        <span v-else class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted">
          <component :is="fallbackIcon" class="size-5 text-muted-foreground" />
        </span>
        <div class="min-w-0">
          <p class="truncate font-medium">
            {{ profile.name }}
          </p>
          <p class="truncate text-sm text-muted-foreground tabular-nums">
            {{ profile.detail }}
          </p>
        </div>
      </CardContent>
    </Card>

    <StatCard
      label="Messages"
      :value="stats?.messages"
      :icon="MessageSquareTextIcon"
      :clickable="canReadMessages"
      @click="messagesOpen = true"
    />
    <StatCard
      label="Chats"
      :value="stats?.chats"
      :icon="MessagesSquareIcon"
      clickable
      @click="chatsOpen = true"
    />
    <StatCard
      v-if="hasContacts"
      label="Contacts"
      :value="stats?.contacts"
      :icon="BookUserIcon"
      clickable
      @click="contactsOpen = true"
    />

    <!-- Inside the grid, full width, so it sits just under the cards rather than
         a whole section gap below them. -->
    <p v-if="receivedLine || countsLine" class="col-span-full -mt-2 text-xs text-muted-foreground">
      <span v-if="receivedLine" :title="lastReceived?.at && formatDateTime(lastReceived.at)">{{ receivedLine }}</span>
      <template v-if="receivedLine && countsLine">
        ·
      </template>
      <span v-if="countsLine" :title="stats?.asOf && formatDateTime(stats.asOf)">{{ countsLine }}</span>
    </p>
  </div>

  <ChatsDialog
    v-model:open="chatsOpen"
    :instance-id="id"
    :kind="kind"
    :total="stats?.chats"
    :more-history="moreHistory"
  />

  <MessagesDialog
    v-model:open="messagesOpen"
    :instance-id="id"
    :kind="kind"
    :total="stats?.messages"
  />

  <ContactsDialog
    v-if="hasContacts"
    v-model:open="contactsOpen"
    :instance-id="id"
  />
</template>
