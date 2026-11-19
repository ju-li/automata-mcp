import { randomBytes } from 'node:crypto'
import type { Actor } from './org'
import type { AppInstance, AppMcpToken } from './app-db'
import type { ExpiryPreset, PublicToken } from './tokens'
import type { McpScope } from './mcp-scope'
import { tokenRequestEmail } from '../emails/account'

/**
 * Connector token requests: a member who reaches a connection but does not
 * manage it asks for a token; whoever manages it approves or declines.
 *
 * A request is an ordinary `app.mcp_tokens` row with `requested_at` set, so
 * every path that already kills tokens — revoke, unassign, demotion, removal —
 * handles requests without knowing they exist. Three rules hold it up:
 *
 * - **Pending never authenticates.** `resolveMcpAuth` refuses a row with
 *   `requested_at` and no `approved_at`, whatever secret is presented. The
 *   row's `token_hash` is the hash of random bytes nobody was shown, so there
 *   is nothing to present anyway; the check is what makes that irrelevant.
 * - **Approval never reveals a secret.** It may run in the manager's browser,
 *   and the secret belongs to the holder. The holder collects it afterwards by
 *   rotating ("Get token"), the one write they may make to their own token.
 * - **The manager decides the scope.** The request carries the member's
 *   proposal; approval writes whatever scope the manager submits.
 */

/** One mail per requester per connection in this window. A speed bump, like invite mail. */
const REQUEST_MAIL_COOLDOWN_MS = 10 * 60 * 1000
const lastRequestMail = new Map<string, number>()

function claimRequestMail(instanceId: string, userId: string): boolean {
  const now = Date.now()
  for (const [key, at] of lastRequestMail) {
    if (now - at >= REQUEST_MAIL_COOLDOWN_MS) lastRequestMail.delete(key)
  }
  const key = `${instanceId}:${userId}`
  if (lastRequestMail.has(key)) return false
  lastRequestMail.set(key, now)
  return true
}

export interface TokenRequestInput {
  label: string
  preset: ExpiryPreset
  scope: McpScope
  sendDisclaimer?: string | null
}

/**
 * File a request. The caller has established that the actor reaches the
 * connection and does not manage it.
 *
 * Counts against `max_tokens` from now on (pending rows are live rows in
 * `orgUsage`), so approving a pile of requests can never land the
 * organization over its limit — which is why approval checks no limit.
 */
export async function createTokenRequest(
  actor: Actor,
  instance: AppInstance,
  input: TokenRequestInput,
): Promise<PublicToken> {
  const sql = await appDb()
  // Nobody is ever shown this. A hash is stored only because the column is
  // NOT NULL and unique; the row authenticates nothing until approved and
  // then rotated.
  const unseen = hashMcpToken(`unissued_${randomBytes(32).toString('base64url')}`)

  let record: AppMcpToken
  try {
    record = await sql.begin(async (tx) => {
      await assertCanAdd(tx, actor.org.id, 'token')
      const [row] = await tx<AppMcpToken[]>`
        INSERT INTO app.mcp_tokens ${tx({
          assigned_to: actor.user.id,
          created_by: actor.user.id,
          instance: instance.id,
          token_hash: unseen,
          label: input.label.trim() || 'Untitled token',
          expires_at: null,
          revoked: false,
          send_disclaimer: input.sendDisclaimer ?? null,
          requested_at: new Date(),
          requested_expiry: input.preset,
          secret_issued: false,
          ...scopeFields(input.scope),
        })}
        RETURNING *
      `
      return row!
    })
  }
  catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      throw createError({
        statusCode: 409,
        statusMessage: 'You already have a request waiting on this connection. It needs to be approved or declined first.',
      })
    }
    throw error
  }

  return toPublicToken(record)
}

/**
 * Who hears about a request: the member who created the connection, while they
 * still manage it; otherwise every admin of the organization. Read through the
 * same rules as the rest of the app — `managesInstance` over loaded facts — so
 * "who may approve" and "who is told" cannot disagree.
 */
export async function requestApprovers(instance: AppInstance, orgId: string): Promise<OrgMember[]> {
  const members = await listOrgMembers(orgId)
  const creator = instance.created_by ? members.find(m => m.userId === instance.created_by) : undefined
  if (creator) {
    const reaches = creator.role === 'admin' || await hasAssignment(creator.userId, instance.id)
    if (managesInstance({ role: creator.role, userId: creator.userId }, instance, reaches)) return [creator]
  }
  return members.filter(m => m.role === 'admin')
}

/**
 * Mail the approvers, one message each (colleagues, not a mailing list — a
 * `to` header would disclose the roster). Never throws; answers how many went
 * out. Runs after the request was stored, so a mail failure costs nothing but
 * the mail: the request still shows on the connection's token list.
 */
export async function notifyTokenRequest(actor: Actor, instance: AppInstance, label: string): Promise<number> {
  if (!claimRequestMail(instance.id, actor.user.id)) return 0
  try {
    const approvers = (await requestApprovers(instance, actor.org.id)).filter(m => m.userId !== actor.user.id)
    const brand = emailBrand()
    const mail = tokenRequestEmail({
      requesterName: actor.user.name?.trim() || actor.user.email,
      requesterEmail: actor.user.email,
      orgName: actor.org.name,
      connectionName: instance.label || instance.name,
      tokenLabel: label,
      url: brand.appUrl ? `${brand.appUrl}/instances/${instance.id}` : undefined,
    }, brand)
    const sent = await Promise.all(approvers.map(m => sendAppEmail({ to: m.email, ...mail })))
    return sent.filter(Boolean).length
  }
  catch (error) {
    console.error(`[token-requests] could not notify approvers of a request on connection ${instance.id}:`, (error as Error)?.message ?? error)
    return 0
  }
}

/**
 * Approve a pending request with the scope the manager chose.
 *
 * Conditional on the row still being pending, so two approvals racing (or an
 * approval racing a decline) cannot both land. Re-checks that the holder still
 * reaches the connection: a token approved for someone who lost access would
 * read "Active" and answer 401 — the born-dead token minting refuses too.
 */
export async function approveTokenRequest(
  actor: Actor,
  instance: AppInstance,
  token: AppMcpToken,
  input: { label?: string, preset: ExpiryPreset, scope: McpScope, sendDisclaimer?: string | null },
): Promise<PublicToken> {
  if (!isPendingRequest(token) || token.revoked) {
    throw createError({ statusCode: 409, statusMessage: 'This request is no longer waiting for approval.' })
  }

  const holder = await requireOrgMember(actor.org.id, token.assigned_to)
  const reaches = holder.role === 'admin' || await hasAssignment(holder.userId, instance.id)
  if (!reaches) {
    throw createError({
      statusCode: 422,
      statusMessage: `${holder.email} no longer has access to this connection, so a token for them would not work. `
        + 'Give them access first, or decline the request.',
    })
  }

  const sql = await appDb()
  return await sql.begin(async (tx) => {
    const [row] = await tx<AppMcpToken[]>`
      UPDATE app.mcp_tokens SET ${tx({
        ...scopeFields(input.scope),
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.sendDisclaimer === undefined ? {} : { send_disclaimer: input.sendDisclaimer }),
        expires_at: expiryFromPreset(input.preset),
        approved_at: new Date(),
        approved_by: actor.user.id,
        updated: new Date(),
      })}
      WHERE id = ${token.id} AND requested_at IS NOT NULL AND approved_at IS NULL AND NOT revoked
      RETURNING *
    `
    if (!row) {
      throw createError({ statusCode: 409, statusMessage: 'This request is no longer waiting for approval.' })
    }
    await recordHostedEvent(tx, {
      type: 'token.created',
      org: actor.org.id,
      userId: row.assigned_to,
      payload: { id: row.id, connection: instance.id, kind: instance.kind },
    })
    return toPublicToken(row)
  })
}
