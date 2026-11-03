<script setup lang="ts">
import { LogInIcon } from '@lucide/vue'

/**
 * How to use an OAuth connector: add the plain `/mcp` URL in the client and
 * sign in. There is no secret to show — that is the point — so this is the
 * same dialog right after creating one and from "How to" later.
 *
 * The holder must sign in as themselves: the consent page offers only the
 * signed-in user's own connectors, so an admin who created one for a colleague
 * hands over the URL and the address, never a credential.
 */
const props = defineProps<{
  open: boolean
  kind: InstanceKind
  label?: string
  scope?: TokenScope
  /** Who must sign in to claim it. Absent when it is the viewer. */
  holderEmail?: string
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const { bearerUrl } = useConnectorUrl()
const cliCommand = computed(() => `claude mcp add --transport http ${props.kind} ${bearerUrl.value}`)
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {{ label ? `Connect “${label}” from Claude` : 'Connect from Claude' }}
        </DialogTitle>
        <DialogDescription>
          No token to copy: add the address below in Claude, then sign in to this
          app when it asks.
        </DialogDescription>
      </DialogHeader>

      <div class="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
        <LogInIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p v-if="holderEmail">
          This connector is issued to <strong class="font-semibold">{{ holderEmail }}</strong>.
          Send them the address — they sign in as themselves to claim it. Nobody
          else can.
        </p>
        <p v-else>
          Sign in as yourself when Claude opens this app, then choose this connector.
        </p>
      </div>

      <p v-if="scope" class="text-sm">
        <span class="text-muted-foreground">Scope:</span> {{ describeScope(scope, kind) }}
      </p>

      <div class="min-w-0 space-y-2">
        <Label>Connector URL</Label>
        <CopyableSnippet :value="bearerUrl" aria-label="Copy connector URL" />
      </div>

      <Tabs default-value="web" class="min-w-0 gap-4">
        <TabsList class="w-full">
          <TabsTrigger value="web">
            Claude.ai
          </TabsTrigger>
          <TabsTrigger value="code">
            Claude Code
          </TabsTrigger>
        </TabsList>

        <TabsContent value="web" class="min-w-0">
          <ol class="list-decimal space-y-2 pl-5 text-sm marker:text-muted-foreground">
            <li>In Claude on the web or the desktop app, open <strong class="font-semibold">Settings → Connectors</strong>.</li>
            <li>Click <strong class="font-semibold">Add custom connector</strong> and paste the URL above. Leave the advanced OAuth fields empty.</li>
            <li>Click <strong class="font-semibold">Connect</strong>. This app opens; sign in, choose the connector and approve.</li>
          </ol>
        </TabsContent>

        <TabsContent value="code" class="min-w-0 space-y-2">
          <CopyableSnippet :value="cliCommand" aria-label="Copy command" />
          <p class="text-sm text-muted-foreground">
            Then run <code class="font-mono">/mcp</code> in Claude Code and choose
            <strong class="font-semibold">Authenticate</strong>. Your browser opens this app to sign in.
          </p>
        </TabsContent>
      </Tabs>

      <p class="text-xs text-muted-foreground">
        Already connected somewhere else? Signing in again moves the connector to
        the new place, and the old one stops working.
      </p>

      <DialogFooter>
        <Button @click="emit('update:open', false)">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
