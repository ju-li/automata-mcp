import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppUser } from './pocketbase'

/**
 * Evolution instance lifecycle. Every call that touches Evolution's instance
 * endpoints lives here, so the admin-key blast radius is one file.
 */

export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

// A type alias rather than an interface on purpose: MCP tool handlers may return
// `Record<string, unknown>`, and interfaces have no implicit index signature, so
// an interface here fails to typecheck at the tool that returns it.
export type InstanceStatus = {
  state: ConnectionState
  profileName?: string
  profilePicUrl?: string
  number?: string
  ownerJid?: string
  disconnectedAt?: string
  stats: {
    messages: number
    chats: number
    contacts: number
  }
}

export interface InstanceQr {
  base64?: string
  code?: string
  pairingCode?: string
  count?: number
}

/** What the UI is allowed to see. Never includes `api_key`. */
export interface PublicInstance {
  id: string
  name: string
  label: string
  created?: string
}

export function toPublicInstance(instance: AppInstance): PublicInstance {
  return {
    id: instance.id,
    name: instance.name,
    label: instance.label || 'WhatsApp account',
    created: instance.created,
  }
}

/**
 * Instance names are server-generated and land in Evolution's URLs. Random
 * rather than derived from the user id, so one user can hold several and no
 * name leaks who owns it.
 */
function generateInstanceName(): string {
  return `i-${randomBytes(8).toString('base64url')}`
}

export async function listInstancesForUser(userId: string): Promise<AppInstance[]> {
  const pb = await pocketbaseAdmin()
  return await pb.collection('instances').getFullList<AppInstance>({
    filter: pb.filter('user = {:uid}', { uid: userId }),
    sort: 'created',
  })
}

/**
 * Resolve an instance id from the URL against the session user.
 *
 * Answers **404** rather than 403 when the instance belongs to someone else —
 * a 403 would confirm the id exists and turn this route into a probe.
 */
export async function requireOwnedInstance(event: H3Event, instanceId: string | undefined): Promise<AppInstance> {
  const user = await requireSessionUser(event)

  if (!instanceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const pb = await pocketbaseAdmin()

  let instance: AppInstance
  try {
    instance = await pb.collection('instances').getOne<AppInstance>(instanceId)
  } catch (error) {
    if (isPocketBaseNotFound(error)) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    throw error
  }

  if (instance.user !== user.id) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  return instance
}

/**
 * Create an Evolution instance and record it.
 *
 * Two systems, so there is a window where they can disagree. Evolution is
 * written first; if the PocketBase write then fails we issue a compensating
 * delete so no orphan instance is left holding a socket on the Evolution
 * server. That compensating call is best-effort by necessity — if it also
 * fails, the original error is still what the caller needs to see.
 *
 * This is also the single place an instances-per-user cap would go.
 */
export async function provisionInstance(user: AppUser, label?: string): Promise<AppInstance> {
  const config = useRuntimeConfig()
  const admin = evolutionAdminClient()
  const name = generateInstanceName()

  const created = await admin<{ instance?: { instanceId?: string }, hash?: string | { apikey?: string } }>(
    '/instance/create',
    {
      method: 'POST',
      body: {
        instanceName: name,
        integration: 'WHATSAPP-BAILEYS',
        // Creating without a QR returns immediately; Evolution otherwise blocks
        // ~5s waiting for one. The pairing page asks for the QR separately.
        qrcode: false,
      },
    },
  )

  // Older Evolution releases returned `hash` as `{ apikey }`. We pin v2.3.7,
  // where it is a plain string, but accept both so an upgrade fails loudly at
  // the check below rather than silently storing "[object Object]".
  const apiKey = typeof created?.hash === 'string' ? created.hash : created?.hash?.apikey

  if (!apiKey) {
    await admin(`/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    throw createError({
      statusCode: 502,
      statusMessage: 'Evolution API did not return an instance token',
    })
  }

  try {
    const pb = await pocketbaseAdmin()
    return await pb.collection('instances').create<AppInstance>({
      user: user.id,
      name,
      instance_id: created?.instance?.instanceId ?? '',
      api_key: apiKey,
      base_url: config.evolutionUrl,
      label: label?.trim() || 'WhatsApp account',
    })
  } catch (error) {
    await admin(`/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    throw error
  }
}

/**
 * Connection state and counts, in one call.
 *
 * `fetchInstances` with an instance's own token returns only that instance —
 * Evolution enforces the scoping, we do not have to filter. An unpaired or
 * unknown instance reports `close` and zeroes rather than throwing, because the
 * dashboard should render for an account that has never been paired.
 */
export async function getInstanceStatus(instance: AppInstance): Promise<InstanceStatus> {
  const evolution = evolutionClientForInstance(instance)

  let rows: EvolutionInstanceRow[] = []
  try {
    rows = await evolution<EvolutionInstanceRow[]>('/instance/fetchInstances')
  } catch {
    return emptyStatus()
  }

  const row = Array.isArray(rows) ? rows.find(r => r?.name === instance.name) ?? rows[0] : undefined
  if (!row) return emptyStatus()

  return {
    state: normalizeState(row.connectionStatus),
    profileName: row.profileName ?? undefined,
    profilePicUrl: row.profilePicUrl ?? undefined,
    number: row.number ?? row.ownerJid?.split('@')[0],
    ownerJid: row.ownerJid ?? undefined,
    disconnectedAt: row.disconnectionAt ?? undefined,
    stats: {
      messages: row._count?.Message ?? 0,
      chats: row._count?.Chat ?? 0,
      contacts: row._count?.Contact ?? 0,
    },
  }
}

/**
 * Current QR, or the connection state once pairing has completed.
 *
 * `GET /instance/connect` is overloaded upstream: it returns a QR while the
 * instance is `close`/`connecting`, and a connection-state object once it is
 * `open`. Hitting it while `close` is also what starts the connection, so the
 * pairing page polling this is what drives pairing forward.
 */
export async function getInstanceQr(instance: AppInstance): Promise<{ state: ConnectionState, qr?: InstanceQr }> {
  const evolution = evolutionClientForInstance(instance)

  const response = await evolution<Record<string, any>>(
    `/instance/connect/${encodeURIComponent(instance.name)}`,
  )

  if (response?.instance?.state) {
    return { state: normalizeState(response.instance.state) }
  }

  if (response?.base64 || response?.code || response?.pairingCode) {
    return {
      state: 'connecting',
      qr: {
        base64: response.base64,
        code: response.code,
        pairingCode: response.pairingCode,
        count: response.count,
      },
    }
  }

  // Evolution returns an empty object in the moment between starting the
  // connection and the first QR being generated. Not an error — poll again.
  return { state: 'connecting' }
}

/**
 * End the WhatsApp session, keeping the instance and its token.
 *
 * Evolution answers 400 when the instance is already disconnected. That is the
 * state the caller asked for, so it is treated as success.
 */
export async function logoutInstance(instance: AppInstance): Promise<void> {
  const evolution = evolutionClientForInstance(instance)
  try {
    await evolution(`/instance/logout/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
  } catch (error) {
    if ((error as { status?: number, statusCode?: number })?.status === 400
      || (error as { statusCode?: number })?.statusCode === 400) {
      return
    }
    throw error
  }
}

/**
 * Destroy the instance: the Evolution instance and everything it stored, plus
 * the PocketBase row. `mcp_tokens` rows cascade away with it, so every token
 * for this account stops authenticating.
 *
 * Evolution is torn down first — if that fails we keep the row, because a row
 * pointing at a live instance is recoverable and a live instance nobody has a
 * record of is not. Evolution logs the instance out itself if it is connected.
 */
export async function deleteInstance(instance: AppInstance): Promise<void> {
  const admin = evolutionAdminClient()

  try {
    await admin(`/instance/delete/${encodeURIComponent(instance.name)}`, { method: 'DELETE' })
  } catch (error) {
    // A 404 means Evolution has already lost it; carry on and clean up our row.
    const status = (error as { status?: number, statusCode?: number })
    if (status?.status !== 404 && status?.statusCode !== 404) throw error
  }

  const pb = await pocketbaseAdmin()
  await pb.collection('instances').delete(instance.id)
}

// ── internals ──────────────────────────────────────────────────────────────

interface EvolutionInstanceRow {
  name?: string
  connectionStatus?: string
  ownerJid?: string
  profileName?: string
  profilePicUrl?: string
  number?: string
  disconnectionAt?: string
  _count?: { Message?: number, Chat?: number, Contact?: number }
}

function emptyStatus(): InstanceStatus {
  return { state: 'close', stats: { messages: 0, chats: 0, contacts: 0 } }
}

function normalizeState(state: string | undefined): ConnectionState {
  return state === 'open' || state === 'connecting' || state === 'close' ? state : 'unknown'
}
