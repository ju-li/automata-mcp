<script setup lang="ts">
import { BadgeCheckIcon } from '@lucide/vue'

/**
 * The apps signed in to this account by OAuth, each with the connections it
 * reaches — the "third-party access" list. Signing one out here ends it for
 * every connection it covers; adding a connection happens on that connection's
 * page ("Add to a sign-in"). Hidden when the deployment has no OAuth or the
 * user has no sign-ins.
 */
interface OwnSession {
  id: string
  client: { name: string, verifiedHost?: string }
  created?: string
  lastUsedAt?: string
  connections: { tokenId: string, id: string, label: string, kind: InstanceKind, handle: string, scope: TokenScope }[]
}

const { data, refresh } = await useFetch<{ sessions: OwnSession[] }>('/api/oauth/sessions', {
  // A deployment without OAuth has no sign-ins to show; a failed list must not
  // break the profile page.
  default: () => ({ sessions: [] }),
})
const { run } = useApiAction()
const ending = ref<string | null>(null)

async function signOut(session: OwnSession) {
  ending.value = session.id
  await run(async () => {
    await $fetch(`/api/oauth/sessions/${session.id}`, { method: 'DELETE' })
    await refresh()
  }, { success: `${session.client.name} signed out`, failure: 'Could not sign it out' })
  ending.value = null
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'
}
</script>

<template>
  <Card v-if="data?.sessions.length">
    <CardHeader>
      <CardTitle>Connected apps</CardTitle>
      <CardDescription>
        Apps you signed in to from Claude or another MCP client, and the connections each can reach.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      <div v-for="session in data.sessions" :key="session.id" class="space-y-2 rounded-md border p-3 text-sm">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="font-medium">
              {{ session.client.name }}
            </p>
            <p v-if="session.client.verifiedHost" class="flex items-center gap-1 text-xs text-muted-foreground">
              <BadgeCheckIcon class="size-3" /> {{ session.client.verifiedHost }}
            </p>
            <p class="text-xs text-muted-foreground">
              Signed in {{ formatDate(session.created) }} · last used {{ formatDate(session.lastUsedAt) }}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button variant="outline" size="sm" :disabled="ending === session.id">
                Sign out
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Sign {{ session.client.name }} out?</AlertDialogTitle>
                <AlertDialogDescription>
                  It stops working immediately on every connection listed here. Signing in
                  again from the app reconnects.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="signOut(session)">
                  Sign out
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <ul v-if="session.connections.length" class="space-y-1">
          <li v-for="connection in session.connections" :key="connection.tokenId" class="flex flex-wrap items-baseline gap-x-2">
            <NuxtLink :to="`/instances/${connection.id}`" class="hover:underline">
              {{ connection.label }}
            </NuxtLink>
            <code class="font-mono text-xs text-muted-foreground">{{ connection.handle }}__…</code>
            <span class="text-xs text-muted-foreground">{{ describeScope(connection.scope, connection.kind) }}</span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">
          No connections left — it reaches nothing and ends the next time the app refreshes.
        </p>
      </div>
    </CardContent>
  </Card>
</template>
