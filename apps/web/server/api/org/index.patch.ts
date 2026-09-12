import { z } from 'zod'
import type { AppOrganization } from '~~/server/utils/pocketbase'

const body = z.object({
  name: z.string().trim().min(1, 'Give the organization a name').max(100),
})

/** Rename the organization. Admin-only; nothing else about it is editable. */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const { name } = await parseBody(event, body)

  const pb = await pocketbaseAdmin()
  const org = await pb.collection('organizations').update<AppOrganization>(actor.org.id, { name })

  return { org: { id: org.id, name: org.name } }
})
