<script setup lang="ts">
/**
 * A mailbox's IMAP login: server, port, security, username, password.
 *
 * The presets fill the server half only — never a password — for the providers
 * people most often mean. There is no "no encryption" choice: a password
 * crossing the network in clear is not an option this app offers, and
 * STARTTLS is enforced (the server refuses a connection that does not upgrade).
 */
const props = defineProps<{ idPrefix: string }>()
const model = defineModel<ImapCredentials>({ required: true })

interface Preset {
  name: string
  host: string
  note: string
}

const presets: Preset[] = [
  { name: 'Gmail', host: 'imap.gmail.com', note: 'Needs 2-Step Verification and an app password (Google Account → Security → App passwords).' },
  { name: 'iCloud', host: 'imap.mail.me.com', note: 'Use your iCloud address and an app-specific password from account.apple.com.' },
  { name: 'Fastmail', host: 'imap.fastmail.com', note: 'Use an app password from Settings → Privacy & Security.' },
  { name: 'Zoho', host: 'imap.zoho.com', note: 'Enable IMAP access in Zoho Mail settings; use an app password if 2FA is on.' },
  { name: 'Yahoo', host: 'imap.mail.yahoo.com', note: 'Use an app password from Account security.' },
]

const preset = ref<Preset>()

function applyPreset(choice: Preset) {
  preset.value = choice
  model.value = { ...model.value, host: choice.host, port: '993', security: 'tls' }
}

function setSecurity(value: unknown) {
  const security = value === 'starttls' ? 'starttls' : 'tls'
  // Move the port with the mode only while it is still the other mode's default.
  const port = model.value.port === '993' || model.value.port === '143' || !model.value.port
    ? (security === 'tls' ? '993' : '143')
    : model.value.port
  model.value = { ...model.value, security, port }
}

const field = (key: keyof ImapCredentials, value: string | number) => {
  model.value = { ...model.value, [key]: String(value) }
}

const id = (name: string) => `${props.idPrefix}-${name}`
</script>

<template>
  <div class="space-y-3">
    <div class="space-y-2">
      <span class="text-sm font-medium">Provider</span>
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="choice in presets"
          :key="choice.name"
          type="button"
          size="sm"
          :variant="preset?.name === choice.name ? 'secondary' : 'outline'"
          @click="applyPreset(choice)"
        >
          {{ choice.name }}
        </Button>
      </div>
      <p v-if="preset" class="text-xs text-muted-foreground">
        {{ preset.note }}
      </p>
    </div>

    <div class="grid grid-cols-[1fr_6rem] gap-3">
      <div class="space-y-2">
        <Label :for="id('host')">IMAP server</Label>
        <Input
          :id="id('host')"
          :model-value="model.host"
          autocomplete="off"
          spellcheck="false"
          placeholder="imap.example.com"
          @update:model-value="field('host', $event)"
        />
      </div>
      <div class="space-y-2">
        <Label :for="id('port')">Port</Label>
        <Input
          :id="id('port')"
          :model-value="model.port"
          inputmode="numeric"
          autocomplete="off"
          placeholder="993"
          @update:model-value="field('port', $event)"
        />
      </div>
    </div>

    <div class="space-y-2">
      <Label :for="id('security')">Security</Label>
      <Select :model-value="model.security" @update:model-value="setSecurity">
        <SelectTrigger :id="id('security')" class="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tls">
            TLS — encrypted from the start (usually port 993)
          </SelectItem>
          <SelectItem value="starttls">
            STARTTLS — upgraded to encrypted (usually port 143)
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="space-y-2">
        <Label :for="id('user')">Username</Label>
        <Input
          :id="id('user')"
          :model-value="model.user"
          autocomplete="off"
          spellcheck="false"
          placeholder="you@example.com"
          @update:model-value="field('user', $event)"
        />
      </div>
      <div class="space-y-2">
        <Label :for="id('password')">Password</Label>
        <Input
          :id="id('password')"
          :model-value="model.password"
          type="password"
          autocomplete="new-password"
          placeholder="App password"
          @update:model-value="field('password', $event)"
        />
      </div>
    </div>
  </div>
</template>
