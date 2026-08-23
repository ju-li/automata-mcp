<script setup lang="ts">
import { toast } from 'vue-sonner'

const label = ref('')
const busy = ref(false)

/**
 * Creating happens on an explicit click, not on mount. Provisioning reserves a
 * live socket on the Evolution server, so a page refresh must not silently
 * create a second account.
 */
async function create() {
  busy.value = true
  try {
    const { instance } = await $fetch<{ instance: { id: string } }>('/api/instances', {
      method: 'POST',
      body: { label: label.value },
    })
    await navigateTo(`/instances/${instance.id}`)
  }
  catch (err: any) {
    toast.error(err?.data?.statusMessage || 'Could not create the connection')
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-md space-y-6">
    <div>
      <h1 class="font-heading text-2xl font-semibold">
        Connect a WhatsApp number
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        You will scan a QR code with the phone you want to connect.
      </p>
    </div>

    <Card>
      <CardContent class="space-y-4 pt-6">
        <div class="space-y-2">
          <Label for="label">Name this account</Label>
          <Input id="label" v-model="label" placeholder="Work phone" @keydown.enter="create" />
          <p class="text-xs text-muted-foreground">
            Just for you — it helps when you have more than one.
          </p>
        </div>

        <Button class="w-full" :disabled="busy" @click="create">
          {{ busy ? 'Setting up…' : 'Continue to QR code' }}
        </Button>
      </CardContent>
    </Card>

    <div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
      <p class="font-medium">
        Use a phone number you can dedicate to this.
      </p>
      <p class="mt-1 text-muted-foreground">
        Pairing links a real WhatsApp account. Repeatedly pairing and unpairing a
        number, or sending unsolicited messages from a freshly paired one, can get
        it banned by WhatsApp.
      </p>
    </div>
  </div>
</template>
