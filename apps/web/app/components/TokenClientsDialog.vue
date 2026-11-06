<script setup lang="ts">
/**
 * Every MCP client a token started a session with.
 *
 * Self-reported throughout — the names and versions are whatever each client
 * sent when it connected — so the copy says so, and the "new" flag is worded
 * as something to check, not as a finding.
 */
defineProps<{
  open: boolean
  label?: string
  clients: TokenClient[]
}>()

defineEmits<{ 'update:open': [value: boolean] }>()
</script>

<template>
  <Dialog :open="open" @update:open="value => $emit('update:open', value)">
    <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-4xl">
      <DialogHeader class="shrink-0">
        <DialogTitle>Clients using “{{ label }}”</DialogTitle>
        <DialogDescription>
          Each MCP client names itself when it connects. A client can call itself
          anything, so treat this as a hint: it helps with support and can point
          at a leaked token, but it proves nothing about who is connecting.
        </DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="!clients.length" class="text-sm text-muted-foreground">
          No client has started a session with this token since clients began
          being recorded.
        </p>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Last session</TableHead>
              <TableHead class="text-right">
                Sessions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="client in clients" :key="JSON.stringify([client.name, client.version])">
              <TableCell class="max-w-sm">
                <div class="flex flex-wrap items-center gap-2 font-medium break-all">
                  {{ clientLabel(client) }}
                  <Badge v-if="client.newClient" variant="secondary">
                    New client
                  </Badge>
                </div>
                <div class="text-xs break-all text-muted-foreground">
                  <span v-if="client.protocolVersion">Protocol {{ client.protocolVersion }}</span>
                  <span v-if="client.protocolVersion && client.userAgent"> · </span>
                  <span v-if="client.userAgent">{{ client.userAgent }}</span>
                </div>
              </TableCell>
              <TableCell class="whitespace-nowrap text-muted-foreground">
                {{ formatDate(client.firstSeen) }}
              </TableCell>
              <TableCell class="whitespace-nowrap text-muted-foreground">
                {{ formatDateTime(client.lastSeen) }}
              </TableCell>
              <TableCell class="text-right text-muted-foreground tabular-nums">
                {{ client.sessions }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <p v-if="clients.some(c => c.newClient)" class="mt-4 text-sm text-muted-foreground">
          <strong class="font-medium text-foreground">New client</strong> means
          this name first connected more than a day after the token's first
          client, within the last two weeks. If you don't recognise it, issue the
          token a new secret. The absence of the label proves nothing: a client
          that took a token can name itself after one you know.
        </p>
      </div>

      <DialogFooter class="shrink-0">
        <Button variant="ghost" @click="$emit('update:open', false)">
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
