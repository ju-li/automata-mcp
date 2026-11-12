import type { PostHog } from 'posthog-js'

/**
 * Product events, sent to PostHog by `plugins/posthog.client.ts` when it loaded
 * (hosted offering, key set). Anywhere else — self-hosted, SSR, before the
 * plugin ran — `track` does nothing. An opted-out organization's users are
 * dropped by PostHog itself (`opt_out_capturing`), and anything sent before the
 * session is read is held back by the plugin's `before_send`.
 *
 * A closed list of events with typed properties, so a call site cannot attach
 * something it should not. Properties are ids, kinds, counts and switches —
 * never a label, chat, folder or table name, host, connection string, token
 * secret or `reason`. Org and person ride on PostHog's own identify/group.
 *
 * Sent from the browser after the server answered, so a request that failed
 * sends nothing, and a change made outside this UI (another tab is fine, the
 * API by hand is not) is not counted. Good enough for product analytics; never
 * bill or limit from these.
 */
export interface AnalyticsEvents {
  connection_created: {
    connection_id: string
    kind: InstanceKind
    own_server: boolean
    full_history?: boolean
  }
  connection_deleted: {
    connection_id: string
    kind: InstanceKind
  }
  token_created: {
    connection_id: string
    kind: InstanceKind
    expiry: string
    all_tools: boolean
    tool_count: number
    all_chats: boolean
    all_tables: boolean
    for_other_member: boolean
  }
  token_revoked: {
    connection_id: string
    kind: InstanceKind
    token_id: string
  }
}

let client: PostHog | undefined

/** Called once by the PostHog plugin, after `init`. */
export function setAnalyticsClient(posthog: PostHog): void {
  client = posthog
}

export function track<E extends keyof AnalyticsEvents>(event: E, properties: AnalyticsEvents[E]): void {
  if (!client) return
  try {
    client.capture(event, properties)
  }
  catch {
    // Analytics must never break the action it records.
  }
}
