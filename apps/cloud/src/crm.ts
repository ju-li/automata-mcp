import type { BrevoSettings } from './config.ts'
import type { Sql } from './db.ts'
import { describeError } from './http-error.ts'

/**
 * Brevo: the only file that talks to the CRM, the way billing.ts is the only
 * one that talks to Stripe. Plain fetch, no SDK — a handful of endpoints.
 * `docs/plans/brevo-crm-sync.md` is the design; `docs/billing.md` the
 * operator's side.
 *
 * Rules that hold it up:
 *
 * - **The event names a user; a live read is what is sent.** `loadUsers()`
 *   reads current state from the app schema, so a replayed or reordered event
 *   sends today's address and organization, never the payload's. The one
 *   exception is `SignupFacts`, which are stored nowhere but the
 *   `user.signed_up` payload.
 * - **A contact is keyed on the user id** (Brevo's `ext_id`), so an email
 *   change re-keys the same contact instead of creating a second one.
 * - **Lists are set only when a contact is created or claimed** — the moment of
 *   signup, and of the consent given there. Every later update leaves list
 *   membership alone, so an unsubscribe in Brevo is never undone.
 * - **A fixed attribute list** (`ATTRIBUTES`). Nothing about connections or
 *   tokens goes to Brevo, and of usage only two dates — the last MCP call by
 *   the user and by anyone in their organization — and only while the
 *   organization has Telemetry on (`activityDates`). Adding a field is a
 *   decision recorded in the plan, not a one-line change. Blacklist and
 *   unsubscribe state are never sent: they belong to Brevo.
 * - **Never logged:** the address, the name, the key, request bodies, or
 *   Brevo's message on a contact call (it may quote the address). Status and
 *   Brevo's `code` are enough to tell the failures apart.
 */

/** The web app migration that adds `app.users.marketing_consent_at`. */
const REQUIRED_APP_MIGRATION = '0009_marketing_consent'

const REQUEST_TIMEOUT_MS = 15_000
/** How long a failed `prepare()` waits before asking Brevo again. */
const PREPARE_RETRY_MS = 5 * 60_000
/** How long a pass waits after a wrong key, or Brevo not answering. */
const AUTH_PAUSE_MS = 60_000
const TRANSIENT_PAUSE_MS = 15_000

type AttributeType = 'text' | 'date' | 'boolean'

/**
 * What an update sends to empty an attribute. Brevo's reference does not say;
 * verified against a real contact on 2026-11-12: `""` empties a date
 * attribute, while `null` answers 204 and changes nothing. Used only for the
 * activity dates: a value Brevo silently ignored would leave a date behind
 * after Telemetry was turned off — so never "simplify" this to `null`.
 */
const CLEARED = ''


/** Everything a contact carries besides its address and id. */
export const ATTRIBUTES = {
  FULL_NAME: 'text',
  SIGNUP_DATE: 'date',
  SIGNUP_PLAN: 'text',
  INVITED: 'boolean',
  ORG_ID: 'text',
  ORG_NAME: 'text',
  ORG_ROLE: 'text',
  PLAN: 'text',
  LAST_MCP_USE: 'date',
  ORG_LAST_MCP_USE: 'date',
} as const satisfies Record<string, AttributeType>

type AttributeName = keyof typeof ATTRIBUTES

/** Facts about the signup itself, read from the `user.signed_up` payload. */
export interface SignupFacts {
  plan?: string
  invited: boolean
}

export interface CrmUser {
  id: string
  email: string
  name: string
  created: string
  marketing_consent_at?: string
  role?: string
  org_id?: string
  org_name?: string
  plan_label?: string
  /** UTC day (`YYYY-MM-DD`) of this user's last MCP call in their organization; absent while Telemetry is off. */
  last_mcp_use?: string
  /** The same for anyone in their organization. */
  org_last_mcp_use?: string
}

export type Upserted = 'created' | 'claimed' | 'updated'

/**
 * What Brevo answered, sorted by what to do about it:
 *
 *   retry       no answer, 5xx, 429 — stop here, try again on a later pass
 *   auth        401 / 403 — the key (or Brevo's authorised IPs) is wrong; stop,
 *               since skipping would throw away every later event too
 *   permanent   any other 4xx — this contact will not go in as it is; record
 *               it in cloud.crm_skipped and move on
 */
export class BrevoError extends Error {
  /** 0 when Brevo did not answer at all. */
  readonly status: number
  readonly code?: string
  /** When Brevo's rate limit resets, if it said. */
  readonly retryAt?: number

  constructor(status: number, code?: string, retryAt?: number, detail?: string) {
    super(status === 0
      ? `Brevo did not answer${detail ? `: ${detail}` : ''}`
      : `Brevo answered ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`)
    this.status = status
    this.code = code
    this.retryAt = retryAt
  }

  get kind(): 'retry' | 'auth' | 'permanent' {
    if (this.status === 0 || this.status >= 500 || this.status === 429) return 'retry'
    if (this.status === 401 || this.status === 403) return 'auth'
    return 'permanent'
  }
}

export class Crm {
  readonly configured: boolean
  private readonly sql: Sql
  private readonly settings?: BrevoSettings
  private ready = false
  private nextPrepareAt = 0
  private pausedUntil = 0
  private announcedWaiting = false

  constructor(sql: Sql, settings?: BrevoSettings) {
    this.sql = sql
    this.settings = settings
    this.configured = Boolean(settings)
  }

  /** For /health: `waiting` until `prepare()` has succeeded once. */
  get status(): 'unconfigured' | 'waiting' | 'ready' {
    if (!this.configured) return 'unconfigured'
    return this.ready ? 'ready' : 'waiting'
  }

  /** True while a pass should not call Brevo: a rate limit, a wrong key, an outage. */
  get paused(): boolean {
    return Date.now() < this.pausedUntil
  }

  /**
   * Check, once, that the sync can do its job, and answer whether it can:
   *
   * - the web app has the consent column (migration 0009);
   * - every attribute in `ATTRIBUTES` exists in Brevo as a normal attribute of
   *   the right type, creating the missing ones — otherwise a typo, or one
   *   nobody created in the dashboard, would mean data that never arrives;
   * - both lists exist.
   *
   * A failure is logged and retried after a while rather than fatal: billing
   * runs in the same process and must not stop over the CRM.
   */
  async prepare(): Promise<boolean> {
    if (!this.settings) return false
    if (this.ready) return true
    if (Date.now() < this.nextPrepareAt) return false

    const [migrated] = await this.sql`SELECT 1 FROM app.migrations WHERE name = ${REQUIRED_APP_MIGRATION}`
    if (!migrated) {
      if (!this.announcedWaiting) {
        this.announcedWaiting = true
        console.info(`[crm] waiting for the web app to apply migration ${REQUIRED_APP_MIGRATION}`)
      }
      this.nextPrepareAt = Date.now() + TRANSIENT_PAUSE_MS
      return false
    }

    try {
      await this.ensureAttributes()
      await this.ensureList(this.settings.productList, 'BREVO_PRODUCT_LIST')
      await this.ensureList(this.settings.marketingList, 'BREVO_MARKETING_LIST')
    }
    catch (error) {
      console.error(`[crm] cannot start the Brevo sync; retrying in ${PREPARE_RETRY_MS / 60_000} minutes: ${describeError(error)}`)
      this.nextPrepareAt = Date.now() + PREPARE_RETRY_MS
      return false
    }

    this.ready = true
    console.info('[crm] Brevo sync ready')
    return true
  }

  /** Current state of these users, keyed by id. A user with no row is absent. */
  async loadUsers(ids: string[]): Promise<Map<string, CrmUser>> {
    if (ids.length === 0) return new Map()
    const rows = await this.sql<CrmUser[]>`
      SELECT u.id, u.email, u.name, u.created, u.marketing_consent_at,
             m.role, o.id AS org_id, o.name AS org_name, o.plan_label,
             ${activityDates(this.sql)}
      FROM app.users u
      LEFT JOIN app.memberships m ON m.user_id = u.id
      LEFT JOIN app.organizations o ON o.id = m.org
      WHERE u.id = ANY(${ids})
    `
    return new Map(rows.map(row => [row.id, row]))
  }

  /**
   * Members whose activity dates differ from what Brevo was last sent
   * (`cloud.crm_last_use`): a new call, Telemetry turned off (dates to clear)
   * or back on. A user never sent anything is listed only once they have a
   * date, so users who never made a call cost nothing. For the daily pass.
   */
  async activityChanged(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT d.id FROM (
        SELECT u.id, ${activityDates(this.sql)}
        FROM app.users u
        JOIN app.memberships m ON m.user_id = u.id
        JOIN app.organizations o ON o.id = m.org
      ) d
      LEFT JOIN cloud.crm_last_use s ON s.user_id = d.id
      WHERE CASE WHEN s.user_id IS NULL
                 THEN d.last_mcp_use IS NOT NULL OR d.org_last_mcp_use IS NOT NULL
                 ELSE s.last_mcp_use IS DISTINCT FROM d.last_mcp_use
                   OR s.org_last_mcp_use IS DISTINCT FROM d.org_last_mcp_use
            END
      ORDER BY d.id
    `
    return rows.map(row => row.id)
  }

  /** Remember the activity dates Brevo now holds for this user. */
  private async recordActivitySent(user: CrmUser): Promise<void> {
    await this.sql`
      INSERT INTO cloud.crm_last_use (user_id, last_mcp_use, org_last_mcp_use)
      VALUES (${user.id}, ${user.last_mcp_use ?? null}, ${user.org_last_mcp_use ?? null})
      ON CONFLICT (user_id) DO UPDATE SET
        last_mcp_use     = EXCLUDED.last_mcp_use,
        org_last_mcp_use = EXCLUDED.org_last_mcp_use,
        sent_at          = now()
    `
  }

  /** The current members of an organization: whose `PLAN` a plan change moves. */
  async membersOf(orgId: string): Promise<string[]> {
    const rows = await this.sql<{ user_id: string }[]>`SELECT user_id FROM app.memberships WHERE org = ${orgId}`
    return rows.map(row => row.user_id)
  }

  /**
   * Bring one contact into line with the user. Idempotent: running it twice
   * costs one extra call and changes nothing.
   *
   *   1. update the contact holding this user id — address included;
   *   2. none: create it, on the product list, and on the marketing list
   *      when consent was given at signup;
   *   3. the address already has a contact without our id (a newsletter
   *      signup, an imported list): claim it, with the same lists.
   *
   * Throws `BrevoError` for the consumer to sort by `kind`.
   */
  async upsert(user: CrmUser, facts?: SignupFacts): Promise<Upserted> {
    const settings = this.requireSettings()
    const attributes = attributesOf(user, facts)

    try {
      await this.call('PUT', `/contacts/${encodeURIComponent(user.id)}?identifierType=ext_id`, {
        attributes: { ...attributes, EMAIL: user.email },
      })
      return 'updated'
    }
    catch (error) {
      if (!(error instanceof BrevoError && error.status === 404)) throw error
    }

    const listIds = user.marketing_consent_at
      ? [settings.productList, settings.marketingList]
      : [settings.productList]
    try {
      // A new contact has nothing to clear.
      await this.call('POST', '/contacts', { email: user.email, ext_id: user.id, attributes: withoutCleared(attributes), listIds })
      return 'created'
    }
    catch (error) {
      if (!(error instanceof BrevoError && error.status === 400 && error.code === 'duplicate_parameter')) throw error
    }

    await this.call('PUT', `/contacts/${encodeURIComponent(user.email)}?identifierType=email_id`, {
      ext_id: user.id,
      attributes,
      listIds,
    })
    return 'claimed'
  }

  /**
   * `upsert`, except that a contact Brevo refuses for good is remembered in
   * `cloud.crm_skipped` (for replaying by hand) and answers `skipped`. Every
   * other failure throws. The one rule the outbox consumer and the backfill both
   * follow, so they cannot drift apart.
   */
  async upsertOrSkip(user: CrmUser, options: { facts?: SignupFacts, eventId?: bigint } = {}): Promise<Upserted | 'skipped'> {
    let result: Upserted
    try {
      result = await this.upsert(user, options.facts)
    }
    catch (error) {
      if (!(error instanceof BrevoError) || error.kind !== 'permanent') throw error
      const { eventId } = options
      await this.sql`
        INSERT INTO cloud.crm_skipped (event_id, user_id, status, code)
        VALUES (${eventId === undefined ? null : eventId.toString()}, ${user.id}, ${error.status}, ${error.code ?? null})
      `
      console.warn(
        `[crm] Brevo refused the contact for user ${user.id}${eventId === undefined ? '' : ` (event ${eventId})`}: `
        + `${error.message}; recorded in cloud.crm_skipped`,
      )
      return 'skipped'
    }
    await this.recordActivitySent(user)
    return result
  }

  /**
   * Hold off further calls after a failure that is not this contact's fault:
   * until Brevo's rate limit resets, a minute for a wrong key, a pass for the
   * rest. Logs it — at most once per pause, since passes stop while paused.
   */
  pauseFor(error: BrevoError): void {
    if (error.kind === 'auth') {
      this.pausedUntil = Date.now() + AUTH_PAUSE_MS
      console.error(`[crm] ${error.message}. Check BREVO_API_KEY and, if Brevo restricts API keys by IP address, that this service's address is authorised. Paused for a minute.`)
      return
    }
    this.pausedUntil = Math.max(error.retryAt ?? 0, Date.now() + TRANSIENT_PAUSE_MS)
    console.warn(`[crm] ${error.message}; trying again in ${Math.ceil((this.pausedUntil - Date.now()) / 1000)} s`)
  }

  private requireSettings(): BrevoSettings {
    if (!this.settings) throw new Error('the Brevo sync is not configured')
    return this.settings
  }

  private async ensureAttributes(): Promise<void> {
    const answer = await this.call('GET', '/contacts/attributes', undefined, { detail: true }) as
      { attributes?: { name?: string, category?: string, type?: string }[] } | undefined
    const existing = answer?.attributes ?? []

    for (const [name, type] of Object.entries(ATTRIBUTES) as [AttributeName, AttributeType][]) {
      const found = existing.find(attribute => attribute.name === name)
      if (!found) {
        await this.call('POST', `/contacts/attributes/normal/${name}`, { type }, { detail: true })
        console.info(`[crm] created Brevo contact attribute ${name} (${type})`)
        continue
      }
      if (found.category !== 'normal' || found.type !== type) {
        throw new Error(
          `Brevo contact attribute ${name} exists as ${found.category ?? '?'}/${found.type ?? '?'}, `
          + `expected normal/${type}. Delete or rename it in Brevo so it can be created as expected.`,
        )
      }
    }
  }

  private async ensureList(id: number, variable: string): Promise<void> {
    try {
      await this.call('GET', `/contacts/lists/${id}`, undefined, { detail: true })
    }
    catch (error) {
      if (error instanceof BrevoError && error.status === 404) {
        throw new Error(`${variable} names Brevo list ${id}, which does not exist`)
      }
      throw error
    }
  }

  /**
   * One request. `detail` adds Brevo's message to the error, and is only for
   * calls about attributes and lists: on a contact call the message may quote
   * the address, which must not reach the log.
   */
  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, options: { detail?: boolean } = {}): Promise<unknown> {
    const settings = this.requireSettings()
    let response: Response
    try {
      response = await fetch(`${settings.apiUrl}${path}`, {
        method,
        headers: {
          'api-key': settings.apiKey,
          'accept': 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    }
    catch (error) {
      throw new BrevoError(0, undefined, undefined, describeError(error))
    }

    const text = await response.text().catch(() => '')
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    }
    catch {
      json = undefined
    }
    if (response.ok) return json

    const fields = (json && typeof json === 'object' ? json : {}) as { code?: unknown, message?: unknown }
    throw new BrevoError(
      response.status,
      typeof fields.code === 'string' ? fields.code : undefined,
      retryAtFrom(response.headers),
      options.detail && typeof fields.message === 'string' ? fields.message.slice(0, 200) : undefined,
    )
  }
}

type Attributes = Partial<Record<AttributeName, string | boolean | typeof CLEARED>>

/**
 * The two activity dates as select-list columns, for a query joining the user
 * as `u` and their organization as `o`. One fragment for the contact read and
 * the daily pass, so what is sent and what is compared cannot drift. Only
 * calls on the current organization's connections count: Telemetry is that
 * organization's switch, and says nothing about one the user has left.
 *
 * Telemetry on = `tool_calls_required OR record_tool_calls`, the same rule as
 * `getToolCallRecording` in the web app and `telemetry` on `/api/auth/me`:
 * always on for Free, the organization's own choice on Pro. Off, both dates
 * are NULL — never sent, and cleared in Brevo.
 */
function activityDates(sql: Sql) {
  return sql`
    CASE WHEN o.tool_calls_required OR o.record_tool_calls THEN (
      SELECT to_char(max(t.last_used_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
      WHERE t.assigned_to = u.id AND i.org = o.id
    ) END AS last_mcp_use,
    CASE WHEN o.tool_calls_required OR o.record_tool_calls THEN (
      SELECT to_char(max(t.last_used_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
      WHERE i.org = o.id
    ) END AS org_last_mcp_use
  `
}

/**
 * The attributes for one contact. A value the user does not have is left out
 * rather than sent empty, so it never clears what is there; every user has a
 * membership, so in practice only the signup facts are ever missing — and
 * those must stay as the signup set them.
 *
 * The activity dates are the exception: always sent, and sent `CLEARED` when
 * absent, since absent means "Telemetry is off" (or no call yet) and a date
 * left behind would keep describing activity the organization opted out of.
 */
function attributesOf(user: CrmUser, facts?: SignupFacts): Attributes {
  const attributes: Attributes = {
    FULL_NAME: user.name,
    SIGNUP_DATE: user.created.slice(0, 10),
    LAST_MCP_USE: user.last_mcp_use ?? CLEARED,
    ORG_LAST_MCP_USE: user.org_last_mcp_use ?? CLEARED,
  }
  if (user.org_id) attributes.ORG_ID = user.org_id
  if (user.org_name) attributes.ORG_NAME = user.org_name
  if (user.role) attributes.ORG_ROLE = user.role
  if (user.plan_label) attributes.PLAN = user.plan_label
  if (facts) {
    if (facts.plan) attributes.SIGNUP_PLAN = facts.plan
    attributes.INVITED = facts.invited
  }
  return attributes
}

function withoutCleared(attributes: Attributes): Attributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== CLEARED)) as Attributes
}

/** Read the signup facts off a `user.signed_up` payload, whatever its age. */
export function signupFactsOf(payload: unknown): SignupFacts {
  const fields = (payload && typeof payload === 'object' ? payload : {}) as { plan?: unknown, invited?: unknown }
  return {
    plan: typeof fields.plan === 'string' ? fields.plan : undefined,
    invited: fields.invited === true,
  }
}

/** Brevo's rate-limit reset (seconds from now), else a standard Retry-After. */
function retryAtFrom(headers: Headers): number | undefined {
  const seconds = Number(headers.get('x-sib-ratelimit-reset') ?? headers.get('retry-after') ?? Number.NaN)
  return Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : undefined
}
