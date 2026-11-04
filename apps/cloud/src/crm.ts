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
 * - **A fixed attribute list** (`ATTRIBUTES`). Nothing about connections,
 *   tokens or usage ever goes to Brevo; adding a field is a decision recorded
 *   in the plan, not a one-line change. Blacklist and unsubscribe state are
 *   never sent: they belong to Brevo.
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
             m.role, o.id AS org_id, o.name AS org_name, o.plan_label
      FROM app.users u
      LEFT JOIN app.memberships m ON m.user_id = u.id
      LEFT JOIN app.organizations o ON o.id = m.org
      WHERE u.id = ANY(${ids})
    `
    return new Map(rows.map(row => [row.id, row]))
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
      await this.call('POST', '/contacts', { email: user.email, ext_id: user.id, attributes, listIds })
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

  /** Remember a contact Brevo refused for good, for replaying by hand. */
  async recordSkipped(eventId: bigint | undefined, userId: string, error: BrevoError): Promise<void> {
    await this.sql`
      INSERT INTO cloud.crm_skipped (event_id, user_id, status, code)
      VALUES (${eventId === undefined ? null : eventId.toString()}, ${userId}, ${error.status}, ${error.code ?? null})
    `
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

/**
 * The attributes for one contact. A value the user does not have is left out
 * rather than sent empty, so it never clears what is there; every user has a
 * membership, so in practice only the signup facts are ever missing — and
 * those must stay as the signup set them.
 */
function attributesOf(user: CrmUser, facts?: SignupFacts): Partial<Record<AttributeName, string | boolean>> {
  const attributes: Partial<Record<AttributeName, string | boolean>> = {
    FULL_NAME: user.name,
    SIGNUP_DATE: user.created.slice(0, 10),
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
