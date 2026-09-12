<script setup lang="ts">
import { BuildingIcon } from '@lucide/vue'

/**
 * Signed in, but a member of no organization.
 *
 * Reachable two ways: an account whose organization was deleted, and an account
 * created before organizations existed that the migration could not place. Every
 * API route answers 403 in this state, so a listing page would render as a wall
 * of errors — this says what happened instead.
 *
 * There is deliberately no "create one for me" button. Handing out an
 * organization to whoever arrives without one would also hand one back to
 * someone an admin had just removed.
 */
const { user, logout } = useSession()
</script>

<template>
  <div class="mx-auto max-w-lg py-10">
    <Card>
      <CardHeader>
        <div class="mb-2 flex size-10 items-center justify-center rounded-md bg-muted">
          <BuildingIcon class="size-5 text-muted-foreground" />
        </div>
        <CardTitle>No organization</CardTitle>
        <CardDescription>
          {{ user?.email }} is signed in but does not belong to an organization yet.
        </CardDescription>
      </CardHeader>

      <CardContent class="space-y-4 text-sm text-muted-foreground">
        <p>
          Connections and connector tokens belong to an organization, so there is
          nothing this account can reach until it is part of one.
        </p>
        <p>
          Ask an admin of your organization to send you an invitation link, then
          open it while signed in as this account.
        </p>
      </CardContent>

      <CardFooter>
        <Button variant="outline" size="sm" @click="logout()">
          Sign out
        </Button>
      </CardFooter>
    </Card>
  </div>
</template>
