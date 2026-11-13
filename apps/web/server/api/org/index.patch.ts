import { z } from 'zod'
import type { AppOrganization } from '~~/server/utils/app-db'
import type { ToolCallSetting } from '~~/server/utils/tool-calls'

const body = z.object({
  name: z.string().trim().min(1, 'Give the organization a name').max(100).optional(),
  /** Record every MCP tool call and its reason. See server/utils/tool-calls.ts. */
  recordToolCalls: z.boolean().optional(),
  /** Whether members may create connections. Admins always may. */
  membersCreateConnections: z.boolean().optional(),
}).refine(
  value => value.name !== undefined || value.recordToolCalls !== undefined || value.membersCreateConnections !== undefined,
  'Nothing to change',
)

/**
 * Rename the organization, turn tool-call recording on or off, or let members
 * create connections (or not). Admin-only. Turning member creation off stops
 * new connections only: ones members already created stay theirs to manage
 * until an admin unassigns them.
 * Recording cannot be turned off while the organization's plan requires it
 * (402 `plan_limit`, from `setToolCallRecording`).
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const { name, recordToolCalls, membersCreateConnections } = await parseBody(event, body)

  let toolCalls: ToolCallSetting | undefined
  if (recordToolCalls !== undefined) toolCalls = await setToolCallRecording(actor.org.id, recordToolCalls)

  const changes = {
    ...(name !== undefined && { name }),
    ...(membersCreateConnections !== undefined && { members_create_connections: membersCreateConnections }),
  }
  const org = Object.keys(changes).length
    ? await updateRow<AppOrganization>('organizations', actor.org.id, changes)
    : actor.org

  return {
    org: { id: org.id, name: org.name },
    toolCalls,
    membersCreateConnections: org.members_create_connections !== false,
  }
})
