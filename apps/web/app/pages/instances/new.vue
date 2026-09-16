<script setup lang="ts">
import type { Component } from 'vue'
import {
  AppleIcon,
  CloudIcon,
  DatabaseIcon,
  HardDriveIcon,
  LeafIcon,
  MessageCircleIcon,
  SendIcon,
  SmartphoneIcon,
} from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * Pick a kind, then fill in that kind's form.
 *
 * Creating happens on an explicit click, not on mount. Provisioning a WhatsApp
 * account reserves a live socket on the Evolution server, so a page refresh must
 * not silently create a second one — and a database connection is proved by
 * actually connecting, which is not something a refresh should re-do either.
 */
const kind = ref<InstanceKind | undefined>()
const label = ref('')
const busy = ref(false)

interface KindCard {
  title: string
  description: string
  icon: Component
}

/**
 * The picker's copy for the kinds that exist, keyed on `InstanceKind` rather
 * than listed in an array on purpose: adding a member to that union then fails
 * to compile here, the same reason every per-kind branch is a `switch` ending in
 * `assertNever`. A card silently missing from the picker is a kind nobody can
 * create.
 */
const kindCards: Record<InstanceKind, KindCard> = {
  whatsapp: {
    title: 'WhatsApp account',
    description: 'Pair a phone by scanning a QR code. Claude can read and send messages.',
    icon: MessageCircleIcon,
  },
  telegram: {
    title: 'Telegram account',
    description: 'Link your account by scanning a QR code. Claude can read and send messages.',
    icon: SendIcon,
  },
  postgres: {
    title: 'PostgreSQL database',
    description: 'Point Claude at a database with a connection string. Read-only by default.',
    icon: DatabaseIcon,
  },
}

/**
 * Presentation order, which the record above does not carry, plus the kinds that
 * do not exist yet. Those are listed so the answer to "can it do MySQL?" is on
 * the page rather than inferred from an absence — no dates are promised.
 */
const groups: {
  heading: string
  kinds: InstanceKind[]
  soon: KindCard[]
}[] = [
  {
    heading: 'Messaging apps',
    kinds: ['whatsapp', 'telegram'],
    soon: [
      {
        title: 'iMessage',
        description: 'Read and send from the Messages account on a Mac.',
        icon: AppleIcon,
      },
      {
        title: 'SMS',
        description: 'Read and send text messages through an SMS provider.',
        icon: SmartphoneIcon,
      },
    ],
  },
  {
    heading: 'Databases',
    kinds: ['postgres'],
    soon: [
      {
        title: 'MySQL',
        description: 'Point Claude at a MySQL or MariaDB database with a connection string.',
        icon: DatabaseIcon,
      },
      {
        title: 'SQLite',
        description: 'Point Claude at a SQLite database file.',
        icon: HardDriveIcon,
      },
      {
        title: 'MongoDB',
        description: 'Point Claude at a MongoDB deployment with a connection string.',
        icon: LeafIcon,
      },
      {
        title: 'DynamoDB',
        description: 'Point Claude at DynamoDB tables in an AWS account.',
        icon: CloudIcon,
      },
    ],
  },
]

// WhatsApp and Telegram: bring-your-own server (an Evolution server, or a Telegram
// bridge). All or nothing — half of it is not completed from our configuration,
// see evolutionAdminCredentials() and telegramAdminCredentials().
const ownServer = ref(false)
const serverUrl = ref('')
const serverKey = ref('')
// Optional even with a server: it only buys reading. Pairing and sending work
// without it, and asking for a database credential up front would be a poor
// trade for someone who only wants Claude to send.
const serverDbUrl = ref('')

// Postgres
const dsn = ref('')

const canSubmit = computed(() => {
  if (busy.value) return false
  if (kind.value === 'postgres') return dsn.value.trim().length > 0
  if (kind.value === 'whatsapp' || kind.value === 'telegram') {
    if (!ownServer.value) return true
    return serverUrl.value.trim().length > 0 && serverKey.value.trim().length > 0
  }
  return false
})

async function create() {
  if (!canSubmit.value) return
  busy.value = true

  const body = kind.value === 'postgres'
    ? { kind: 'postgres', label: label.value, dsn: dsn.value.trim() }
    : {
        kind: kind.value,
        label: label.value,
        ...(ownServer.value && {
          server: {
            baseUrl: serverUrl.value.trim(),
            adminKey: serverKey.value.trim(),
            ...(serverDbUrl.value.trim() && { dbUrl: serverDbUrl.value.trim() }),
          },
        }),
      }

  try {
    const { instance } = await $fetch<{ instance: { id: string } }>('/api/instances', {
      method: 'POST',
      body,
    })
    await navigateTo(`/instances/${instance.id}`)
  }
  catch (err: any) {
    // The server's message is the useful part here — it names the bad host, the
    // refused address or the connection error — so show it rather than a generic.
    toast.error(apiErrorMessage(err, 'Could not create the connection'))
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-md space-y-6">
    <div>
      <h1 class="font-heading text-2xl font-semibold">
        Add a connection
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Each connection gets its own Claude connector, and each connector token
        reaches exactly one connection.
      </p>
    </div>

    <!-- ── kind ─────────────────────────────────────────────────────────── -->
    <div v-if="!kind" class="space-y-6">
      <section v-for="group in groups" :key="group.heading" class="space-y-3">
        <h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {{ group.heading }}
        </h2>

        <div class="grid gap-3">
          <button
            v-for="available in group.kinds"
            :key="available"
            type="button"
            class="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
            @click="kind = available"
          >
            <component :is="kindCards[available].icon" class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <span>
              <span class="block font-medium">{{ kindCards[available].title }}</span>
              <span class="block text-sm text-muted-foreground">
                {{ kindCards[available].description }}
              </span>
            </span>
          </button>

          <!--
            Nothing to press, so not a control at all: a disabled button still
            reads as one that should work.
          -->
          <div
            v-for="card in group.soon"
            :key="card.title"
            class="flex items-start gap-3 rounded-lg border border-dashed p-4 opacity-60"
          >
            <component :is="card.icon" class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div>
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ card.title }}</span>
                <Badge variant="secondary">
                  Coming soon
                </Badge>
              </div>
              <span class="block text-sm text-muted-foreground">
                {{ card.description }}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ── the form for the chosen kind ─────────────────────────────────── -->
    <template v-else>
      <Card>
        <CardContent class="space-y-4 pt-6">
          <div class="space-y-2">
            <Label for="label">Name this connection</Label>
            <Input
              id="label"
              v-model="label"
              :placeholder="kind === 'postgres' ? 'Production analytics' : kind === 'telegram' ? 'Personal Telegram' : 'Work phone'"
              @keydown.enter="create"
            />
            <p class="text-xs text-muted-foreground">
              Just for you — it helps when you have more than one.
            </p>
          </div>

          <!-- Postgres -->
          <template v-if="kind === 'postgres'">
            <Separator />
            <div class="space-y-2">
              <Label for="dsn">Connection string</Label>
              <Input
                id="dsn"
                v-model="dsn"
                autocomplete="off"
                spellcheck="false"
                placeholder="postgres://user:password@host:5432/database"
              />
              <p class="text-xs text-muted-foreground">
                Checked by actually connecting before it is saved, and never shown
                again afterwards. It is stored so this app can reconnect, so treat
                the password in it as one this server holds.
              </p>
            </div>
          </template>

          <!-- Telegram -->
          <template v-else-if="kind === 'telegram'">
            <Separator />
            <div class="flex items-start gap-2">
              <Checkbox
                id="own-bridge"
                :model-value="ownServer"
                @update:model-value="value => ownServer = value === true"
              />
              <div class="space-y-1">
                <Label for="own-bridge" class="font-normal">
                  Use my own Telegram bridge
                </Label>
                <p class="text-xs text-muted-foreground">
                  Leave this off to use the bridge this app is configured with.
                </p>
              </div>
            </div>

            <div v-if="ownServer" class="space-y-4 rounded-md border p-3">
              <div class="space-y-2">
                <Label for="bridge-url">Bridge URL</Label>
                <Input
                  id="bridge-url"
                  v-model="serverUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://telegram-bridge.example.com"
                />
              </div>
              <div class="space-y-2">
                <Label for="bridge-key">Admin key</Label>
                <Input
                  id="bridge-key"
                  v-model="serverKey"
                  type="password"
                  autocomplete="off"
                  placeholder="TELEGRAM_BRIDGE_ADMIN_KEY"
                />
                <p class="text-xs text-muted-foreground">
                  Your bridge's <span class="font-mono">TELEGRAM_BRIDGE_ADMIN_KEY</span>. It
                  creates and deletes sessions on that bridge.
                </p>
              </div>
              <div class="space-y-2">
                <Label for="bridge-db">Database connection string <span class="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="bridge-db"
                  v-model="serverDbUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="postgresql://user:password@host:5432/database"
                />
                <p class="text-xs text-muted-foreground">
                  Your bridge's database. Claude needs it to <span class="font-medium">read and
                  search</span> chats; linking and sending work without it, and you can add it later.
                </p>
              </div>
            </div>
          </template>

          <!-- WhatsApp -->
          <template v-else>
            <Separator />
            <div class="flex items-start gap-2">
              <Checkbox
                id="own-server"
                :model-value="ownServer"
                @update:model-value="value => ownServer = value === true"
              />
              <div class="space-y-1">
                <Label for="own-server" class="font-normal">
                  Use my own Evolution API server
                </Label>
                <p class="text-xs text-muted-foreground">
                  Leave this off to use the server this app is configured with.
                </p>
              </div>
            </div>

            <div v-if="ownServer" class="space-y-4 rounded-md border p-3">
              <div class="space-y-2">
                <Label for="server-url">Server URL</Label>
                <Input
                  id="server-url"
                  v-model="serverUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://evolution.example.com"
                />
              </div>
              <div class="space-y-2">
                <Label for="server-key">Global API key</Label>
                <Input
                  id="server-key"
                  v-model="serverKey"
                  type="password"
                  autocomplete="off"
                  placeholder="AUTHENTICATION_API_KEY"
                />
                <p class="text-xs text-muted-foreground">
                  This is your server's <span class="font-mono">AUTHENTICATION_API_KEY</span>.
                  It can create and delete instances on that server, so it is a
                  wider secret than the per-account token this app normally holds.
                </p>
              </div>

              <div class="space-y-2">
                <Label for="server-db">Database connection string <span class="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="server-db"
                  v-model="serverDbUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="postgres://reader:password@host:5432/evolution"
                />
                <p class="text-xs text-muted-foreground">
                  Your Evolution server's own Postgres. Claude needs it to
                  <span class="font-medium">read and search</span> messages —
                  Evolution's API cannot search message content. Pairing, listing
                  chats and sending all work without it, and you can add it later.
                  A <span class="font-mono">SELECT</span>-only role is enough.
                </p>
              </div>
            </div>
          </template>

          <Button class="w-full" :disabled="!canSubmit" @click="create">
            <template v-if="busy">
              {{ kind === 'postgres' ? 'Connecting…' : 'Setting up…' }}
            </template>
            <template v-else>
              {{ kind === 'postgres' ? 'Connect database' : 'Continue to QR code' }}
            </template>
          </Button>

          <Button variant="ghost" class="w-full" :disabled="busy" @click="kind = undefined">
            Back
          </Button>
        </CardContent>
      </Card>

      <div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <template v-if="kind === 'postgres'">
          <p class="font-medium">
            Connect with a role that can do only what you need.
          </p>
          <p class="mt-1 text-muted-foreground">
            Per-token table allowlists keep Claude inside the tables you choose,
            but the real boundary is the database role: a role that can read
            everything can be talked into reading everything. Create a role with
            <span class="font-mono">GRANT SELECT</span> on just the tables you
            want, and use that here.
          </p>
        </template>
        <template v-else-if="kind === 'telegram'">
          <p class="font-medium">
            Use an account you are comfortable linking to a third-party app.
          </p>
          <p class="mt-1 text-muted-foreground">
            This app signs in as an unofficial Telegram client, which Telegram watches
            more closely than its own apps, and Telegram's API terms restrict using
            chats for AI. Linking happens on the next page, by QR code.
          </p>
        </template>
        <template v-else>
          <p class="font-medium">
            Use a phone number you can dedicate to this.
          </p>
          <p class="mt-1 text-muted-foreground">
            Pairing links a real WhatsApp account. Repeatedly pairing and
            unpairing a number, or sending unsolicited messages from a freshly
            paired one, can get it banned by WhatsApp.
          </p>
        </template>
      </div>
    </template>
  </div>
</template>
