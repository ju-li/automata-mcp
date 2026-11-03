<script setup lang="ts">
import { LogInIcon } from '@lucide/vue'

/**
 * How to connect by signing in: add the plain `/mcp` URL in the client, sign in
 * to this app, pick connections. There is no secret to show — that is the
 * point — and nothing to create first: one sign-in can cover several
 * connections, each picked on the consent page.
 */
defineProps<{
  open: boolean
  kind: InstanceKind
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const { bearerUrl } = useConnectorUrl()
// One sign-in can cover several kinds, so the server is named after the app,
// not after this connection's kind.
const cliCommand = computed(() => `claude mcp add --transport http automata ${bearerUrl.value}`)
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Connect from Claude</DialogTitle>
        <DialogDescription>
          No token to copy: add the address below in Claude, then sign in to this
          app when it asks.
        </DialogDescription>
      </DialogHeader>

      <div class="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
        <LogInIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p>
          One sign-in can cover several connections: pick them on the page this
          app shows, and each one's tools appear under its own prefix. Anyone this
          connection is assigned to can do the same as themselves.
        </p>
      </div>

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
            <li>Click <strong class="font-semibold">Connect</strong>. This app opens; sign in, pick connections and approve.</li>
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
        Signing in again from the same app replaces its earlier sign-in — the way
        to add or drop connections later.
      </p>

      <DialogFooter>
        <Button @click="emit('update:open', false)">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
