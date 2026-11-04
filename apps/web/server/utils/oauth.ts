import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppUser, Db } from './app-db'
import type { Actor } from './org'
import type { InstanceKind, McpScope } from './mcp-scope'
import type { ScopeInput } from './scope-schema'

/**
 * OAuth 2.1 for the MCP endpoint: this app as both the authorization server
 * and the resource server. The only file that mints or spends an authorization
 * code, an OAuth access token or a refresh token — the same rule `invites.ts`
 * and `email-verification.ts` keep for theirs.
 *
 * **OAuth changes how a secret reaches the client, never what it reaches.**
 * A grant is an ordinary `app.mcp_tokens` row (`auth_method = 'oauth'`), made
 * by an admin with the same checks, scope and limits as a static token, so
 * `resolveMcpAuth`, the kind and scope gates, `mcpLimitRefusal` and the four
 * token-killing operations need nothing new. What an admin creates is a grant
 * with no secret ("awaiting sign-in"); its holder claims it by signing in from
 * an MCP client. Nobody widens anything on the consent page — a member could
 * not before, and still cannot.
 *
 * The auth split holds. The session cookie is read on the consent page and its
 * POST only (web surface). The token endpoint authenticates with a PKCE
 * verifier or a refresh token and never looks at a cookie. `/mcp` still takes
 * only a bearer token.
 *
 * Every URL here is built from `NUXT_PUBLIC_APP_URL`, never the request's
 * `Host` — the same rule passkeys and verification links keep. Unset, OAuth is
 * off: discovery answers 404 and the MCP 401 carries no metadata pointer.
 */

/**
 * OAuth access tokens. Distinct from a static token's `wamcp_` (mcp-auth.ts),
 * so a support ticket says which kind it is.
 */
export const ACCESS_TOKEN_PREFIX = 'wamcpo_'
const REFRESH_TOKEN_PREFIX = 'wamcpr_'
const CODE_PREFIX = 'wamcpc_'
const CLIENT_PREFIX = 'mcpc_'

/**
 * The one OAuth scope. What a sign-in may reach is decided per connection on
 * the consent page, which is finer than scopes can say; the scope exists
 * because the MCP spec asks servers to advertise one (`scopes_supported`, and
 * `scope` in the 401 challenge) and some clients fall back to it.
 */
export const OAUTH_SCOPE = 'mcp'

/** One hour. Short, because a refresh is cheap and a leaked access token is not. */
export const ACCESS_TOKEN_TTL_S = 60 * 60
const CODE_TTL_MS = 60 * 1000
/**
 * A refresh token replaced less than this long ago, presented again, is read as
 * a client racing itself (two workers refreshing at once, a retry after a lost
 * response) — refused, but nothing unclaimed. Older than this it is reuse, and
 * the grant is signed out.
 */
const REFRESH_REUSE_GRACE_MS = 30 * 1000

// ── settings ───────────────────────────────────────────────────────────────

export interface OAuthSettings {
  /** The authorization server's identifier, `NUXT_PUBLIC_APP_URL` without a trailing slash. */
  issuer: string
  /** The protected resource: the MCP endpoint. */
  resource: string
  /**
   * When non-empty, the only hosts a client may register a redirect for, besides
   * loopback. Deployment-wide on purpose: a per-connection switch would let any
   * user turn the check off for themselves.
   */
  redirectHosts: string[]
}

let warned = false

export function oauthSettings(): OAuthSettings | undefined {
  const config = useRuntimeConfig()
  if (String(config.public.oauth ?? '').trim().toLowerCase() === 'off') return undefined

  const appUrl = String(config.public.appUrl ?? '').trim()
  if (!appUrl) {
    if (!warned) {
      warned = true
      console.warn('[oauth] OAuth sign-in for MCP clients is off: set NUXT_PUBLIC_APP_URL to the address people open the app at')
    }
    return undefined
  }
  let issuer: string
  try {
    const url = new URL(appUrl)
    issuer = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  }
  catch {
    if (!warned) {
      warned = true
      console.error('[oauth] OAuth sign-in for MCP clients is off: NUXT_PUBLIC_APP_URL is not a URL')
    }
    return undefined
  }

  const redirectHosts = String(config.oauthRedirectHosts ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)

  return { issuer, resource: `${issuer}/mcp`, redirectHosts }
}

/** For routes that exist only while OAuth is on. 404, so a deployment without it shows nothing. */
export function requireOAuth(): OAuthSettings {
  const settings = oauthSettings()
  if (!settings) throw createError({ statusCode: 404, statusMessage: 'OAuth is not enabled on this deployment' })
  return settings
}

// ── discovery ──────────────────────────────────────────────────────────────

/** RFC 9728. */
export function protectedResourceMetadata(settings: OAuthSettings) {
  return {
    resource: settings.resource,
    authorization_servers: [settings.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: 'Automata MCP',
  }
}

/** RFC 8414. Authorization code + PKCE (S256) + refresh, public clients only. */
export function authorizationServerMetadata(settings: OAuthSettings) {
  return {
    issuer: settings.issuer,
    authorization_endpoint: `${settings.issuer}/oauth/authorize`,
    token_endpoint: `${settings.issuer}/api/oauth/token`,
    // Dynamic Client Registration: deprecated by the MCP spec (2026-07-28) in
    // favour of Client ID Metadata Documents, kept for clients that have not
    // moved. Clients prefer CIMD when the flag below is set.
    registration_endpoint: `${settings.issuer}/api/oauth/register`,
    client_id_metadata_document_supported: true,
    revocation_endpoint: `${settings.issuer}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE],
  }
}

/**
 * The `WWW-Authenticate` pointer an MCP client follows to discover all of the
 * above, or `undefined` when there is nothing to point at.
 */
export function resourceMetadataUrl(): string | undefined {
  const settings = oauthSettings()
  return settings ? `${settings.issuer}/.well-known/oauth-protected-resource/mcp` : undefined
}

/**
 * Answer a discovery document, or the same JSON 404 the toolkit gives when
 * OAuth is off — an HTML error page there reads to a client as a malformed
 * OAuth response rather than "no OAuth here".
 */
export function metadataOr404(event: H3Event, build: (settings: OAuthSettings) => object): object {
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  const settings = oauthSettings()
  if (!settings) {
    setResponseStatus(event, 404)
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { error: 'not_found', error_description: 'OAuth is not enabled on this deployment.' }
  }
  return build(settings)
}

// ── errors ─────────────────────────────────────────────────────────────────

/**
 * An RFC 6749 error, for the token, registration and revocation endpoints,
 * whose callers are OAuth clients parsing `{ error, error_description }` rather
 * than people reading a Nuxt error page.
 */
export class OAuthError extends Error {
  constructor(readonly status: number, readonly code: string, description: string) {
    super(description)
  }
}

/**
 * Answer an OAuth endpoint, turning failures into the shape clients parse.
 *
 * Anything that is not an `OAuthError` — the app database down, above all — is
 * logged and answered **503 `temporarily_unavailable`**, never `invalid_grant`.
 * `invalid_grant` tells a client to throw its refresh token away; doing that
 * during an outage signs every connector out for good, which is the OAuth form
 * of the 401-during-outage rule `resolveMcpAuth` keeps.
 */
export async function answerOAuth<T>(event: H3Event, label: string, run: () => Promise<T>): Promise<T | { error: string, error_description: string }> {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Pragma', 'no-cache')
  try {
    return await run()
  }
  catch (error) {
    if (error instanceof OAuthError) {
      setResponseStatus(event, error.status)
      return { error: error.code, error_description: error.message }
    }
    const status = (error as { statusCode?: number })?.statusCode
    if (status === 404) {
      setResponseStatus(event, 404)
      return { error: 'not_found', error_description: 'OAuth is not enabled on this deployment.' }
    }
    if (status === 429) {
      setResponseStatus(event, 429)
      return { error: 'slow_down', error_description: (error as Error).message || 'Too many requests.' }
    }
    console.error(`[oauth] ${label} failed:`, error)
    setResponseStatus(event, 503)
    return { error: 'temporarily_unavailable', error_description: 'Try again shortly.' }
  }
}

// ── secrets ────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function secret(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

/** PKCE S256: base64url(sha256(verifier)) against the stored challenge, in constant time. */
function pkceMatches(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: 43–128 characters of the unreserved set.
  if (!/^[\w.~-]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const stored = Buffer.from(challenge)
  return computed.length === stored.length && timingSafeEqual(computed, stored)
}

// ── clients (RFC 7591) ─────────────────────────────────────────────────────

export interface OAuthClient {
  id: string
  name: string
  redirect_uris: string[]
  /** `cimd`: `id` is the URL of its metadata document — a domain it controls. */
  registration: 'dcr' | 'cimd'
  created?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether a redirect URI may be registered or used: `https`, or `http` on
 * loopback for native clients (Claude Code, desktop apps) — RFC 8252. No
 * fragment, no credentials in the URL. With an allowlist configured, a
 * non-loopback host must be on it; loopback is always allowed, since a code
 * delivered there never leaves the user's own machine.
 */
export function isAllowedRedirectUri(uri: string, settings: OAuthSettings): boolean {
  let url: URL
  try {
    url = new URL(uri)
  }
  catch {
    return false
  }
  if (url.hash || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  const loopback = LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(`[${host}]`)
  if (url.protocol === 'http:') return loopback
  if (url.protocol !== 'https:') return false
  if (loopback || settings.redirectHosts.length === 0) return true
  return settings.redirectHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))
}

/**
 * Registration attempts per client address per hour. A speed bump, like the
 * invitation-mail throttle: registration is open by design (that is what lets
 * Claude add the connector with no setup), so this only bounds how fast one
 * address can fill the table.
 */
const REGISTRATIONS_PER_HOUR = 30
const registrations = new Map<string, number[]>()

function assertRegistrationAllowed(event: H3Event): void {
  const now = Date.now()
  const key = clientIp(event)
  const recent = (registrations.get(key) ?? []).filter(at => now - at < 60 * 60 * 1000)
  if (recent.length >= REGISTRATIONS_PER_HOUR) {
    throw new OAuthError(429, 'slow_down', 'Too many client registrations from this address. Try again later.')
  }
  recent.push(now)
  registrations.set(key, recent)
  if (registrations.size > 10_000) {
    for (const [ip, times] of registrations) {
      if (!times.some(at => now - at < 60 * 60 * 1000)) registrations.delete(ip)
    }
  }
}

export async function registerClient(event: H3Event, settings: OAuthSettings, body: unknown) {
  assertRegistrationAllowed(event)

  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const uris = input.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(u => typeof u === 'string' && u.length <= 2000)) {
    throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris must list between 1 and 10 URLs.')
  }
  for (const uri of uris as string[]) {
    if (!isAllowedRedirectUri(uri, settings)) {
      throw new OAuthError(400, 'invalid_redirect_uri', `This deployment does not accept the redirect URI ${uri}.`)
    }
  }

  const grantTypes = input.grant_types
  if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))) {
    throw new OAuthError(400, 'invalid_client_metadata', 'Only the authorization_code grant (with refresh_token) is supported.')
  }
  const responseTypes = input.response_types
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || !responseTypes.every(t => t === 'code'))) {
    throw new OAuthError(400, 'invalid_client_metadata', 'Only the code response type is supported.')
  }

  const rawName = typeof input.client_name === 'string' ? input.client_name.trim() : ''
  // Control characters out: the name is shown on the consent page.
  const name = rawName.replace(/\p{Cc}/gu, '').slice(0, 100) || 'Unnamed client'

  // SEP-837: a native app says so, which is what makes its loopback redirect
  // expected rather than odd. Both kinds get the same redirect rules here.
  const applicationType = input.application_type === 'native' ? 'native' : 'web'

  const id = CLIENT_PREFIX + randomBytes(16).toString('base64url')
  const sql = await appDb()
  const [client] = await sql<OAuthClient[]>`
    INSERT INTO app.oauth_clients ${sql({ id, name, redirect_uris: uris, registration: 'dcr' })}
    RETURNING id, name, redirect_uris, registration, created
  `

  setResponseStatus(event, 201)
  // RFC 7591 lets the server replace requested metadata; the client must use
  // what comes back. Every client is public here, whatever it asked for.
  return {
    client_id: client!.id,
    client_id_issued_at: Math.floor(new Date(client!.created ?? Date.now()).getTime() / 1000),
    client_name: client!.name,
    redirect_uris: client!.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: applicationType,
  }
}

/**
 * The client an authorization request names: a metadata document (an `https`
 * URL — fetched and cached, `oauth-client-metadata.ts`) or a DCR registration.
 */
async function getClient(db: Db, id: string | undefined, settings: OAuthSettings): Promise<OAuthClient | undefined> {
  if (!id) return undefined
  if (isMetadataClientId(id)) return await resolveMetadataClient(id, settings)
  const [client] = await db<OAuthClient[]>`
    SELECT id, name, redirect_uris, registration, created FROM app.oauth_clients
    WHERE id = ${id} AND registration = 'dcr'
  `
  return client
}

// ── the authorization request ──────────────────────────────────────────────

export interface AuthorizationParams {
  response_type?: string
  client_id?: string
  redirect_uri?: string
  code_challenge?: string
  code_challenge_method?: string
  state?: string
  resource?: string
  scope?: string
}

export interface AuthorizationRequest {
  client: OAuthClient
  redirectUri: string
  codeChallenge: string
  state?: string
  resource: string
}

/**
 * Validate an authorization request, in the order RFC 6749 §4.1.2.1 requires.
 *
 * A bad `client_id` or `redirect_uri` is **never** redirected — that would send
 * the browser, and an error, to an address nobody vouched for — so it throws a
 * plain 400 the consent page shows. Everything after that point is sent back to
 * the client's (now verified) redirect URI as `?error=…`, through `errorRedirect`.
 */
export async function validateAuthorizationRequest(
  settings: OAuthSettings,
  params: AuthorizationParams,
): Promise<{ request: AuthorizationRequest } | { errorRedirect: string }> {
  const sql = await appDb()
  const client = await getClient(sql, str(params.client_id), settings)
  if (!client) {
    throw createError({ statusCode: 400, statusMessage: 'This sign-in link names an application this deployment does not know. Start again from the app you were connecting.' })
  }

  const requested = str(params.redirect_uri)
  const redirectUri = requested ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined)
  if (!redirectUri || !client.redirect_uris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri, settings)) {
    throw createError({ statusCode: 400, statusMessage: 'This sign-in link would send you to an address the application did not register. Nothing was shared.' })
  }

  const state = str(params.state)
  const fail = (error: string, description: string) => ({
    errorRedirect: buildRedirect(redirectUri, { error, error_description: description, state, iss: settings.issuer }),
  })

  if (str(params.response_type) !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported.')
  }
  const codeChallenge = str(params.code_challenge)
  if (!codeChallenge || str(params.code_challenge_method) !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  }
  if (!/^[\w-]{43}$/.test(codeChallenge)) {
    return fail('invalid_request', 'code_challenge is not a base64url SHA-256 digest.')
  }
  const resource = str(params.resource)
  if (resource && normaliseResource(resource) !== settings.resource) {
    return fail('invalid_target', `This server issues tokens for ${settings.resource} only.`)
  }

  return { request: { client, redirectUri, codeChallenge, state, resource: settings.resource } }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2000 ? value : undefined
}

function normaliseResource(value: string): string {
  return value.replace(/\/+$/, '')
}

export function buildRedirect(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

// ── consent ────────────────────────────────────────────────────────────────

/**
 * One connection as the consent page offers it.
 *
 * `ceiling` is the most this user may grant it: everything for an admin (they
 * could mint any token anyway), the connection's `connection_oauth_policy` for a
 * member — and no policy, or one with members switched off, means the
 * connection is shown but cannot be picked (`allowed: false`). `defaultScope` is
 * what is granted when the user does not customize: the token dialog's default
 * for the kind (`defaultScopeFor`), clamped to the ceiling.
 */
export interface ConsentOption {
  connection: { id: string, label: string, kind: InstanceKind, handle: string }
  allowed: boolean
  ceiling: ScopeInput
  ceilingIsOpen: boolean
  defaultScope: ScopeInput
  /** A member's sends carry the ceiling's disclaimer, whatever they pick. */
  disclaimer?: string
}

interface PolicyRow {
  instance: string
  members_allowed: boolean
  all_chats: boolean
  chat_jids: unknown
  all_tables: boolean
  table_names: unknown
  all_tools: boolean
  tool_names: unknown
  send_disclaimer?: string
}

interface ResolvedOption {
  option: ConsentOption
  instance: AppInstance
  ceiling?: McpScope
  defaultScope?: McpScope
}

/**
 * The connections the actor reaches, each with what they may grant it.
 * Reach is `authorizesInstance`'s rule — an admin every connection of the
 * organization, a member the ones assigned to them — read as a predicate.
 */
async function resolveConsentOptions(actor: Actor): Promise<ResolvedOption[]> {
  const sql = await appDb()
  const isAdmin = actor.role === 'admin'
  const instances = (await listOrgInstances(actor.org.id)).filter(isSupportedInstance)
  const assigned = isAdmin ? undefined : new Set(await listAssignedInstanceIds(actor.user.id))
  const reachable = instances.filter(i => authorizesInstance(
    { role: actor.role, orgId: actor.org.id }, i.org, assigned?.has(i.id) ?? false,
  ))
  const policies = reachable.length && !isAdmin
    ? await sql<PolicyRow[]>`SELECT * FROM app.connection_oauth_policy WHERE instance = ANY(${reachable.map(i => i.id)})`
    : []
  const policyFor = new Map(policies.map(p => [p.instance, p]))

  return reachable.map((instance) => {
    const kind = instanceKind(instance)
    const policy = policyFor.get(instance.id)
    const ceiling = isAdmin ? OPEN_SCOPE : policy?.members_allowed ? scopeFromRecord(policy) : undefined
    const defaultScope = ceiling ? clampedDefault(kind, ceiling) : undefined
    const publicInstance = toPublicInstance(instance)
    return {
      instance,
      ceiling,
      defaultScope,
      option: {
        connection: { id: instance.id, label: publicInstance.label, kind, handle: instance.handle },
        allowed: Boolean(ceiling),
        ceiling: scopeToInput(ceiling ?? OPEN_SCOPE),
        ceilingIsOpen: isAdmin,
        defaultScope: scopeToInput(defaultScope ?? OPEN_SCOPE),
        disclaimer: isAdmin ? undefined : policy?.send_disclaimer || undefined,
      },
    }
  })
}

/** A kind's default scope inside a ceiling; the ceiling itself when the two share no tool. */
function clampedDefault(kind: InstanceKind, ceiling: McpScope): McpScope {
  const clamped = intersectScope(defaultScopeFor(kind), ceiling)
  return !clamped.allTools && clamped.toolNames.length === 0 ? ceiling : clamped
}

export async function listConsentOptions(actor: Actor): Promise<ConsentOption[]> {
  return (await resolveConsentOptions(actor)).map(r => r.option)
}

/** What the consent page sends back per connection picked. */
export interface ConsentSelection {
  connection: string
  /** Absent = the option's `defaultScope`. Must sit within the ceiling. */
  scope?: ScopeInput
  /** An admin's choice; ignored for a member, whose sends carry the ceiling's. */
  send_disclaimer?: string | null
}

/** What a code carries until it is exchanged. Plain JSON in `oauth_codes.selections`. */
interface StoredSelection {
  instance: string
  scope: ScopeInput
  sendDisclaimer: string | null
}

/**
 * Validate what the user picked against what they may grant *now* — the page is
 * not trusted to have been fresh, nor to have kept within the ceiling.
 */
async function validateSelections(actor: Actor, selections: ConsentSelection[]): Promise<{ stored: StoredSelection[], instances: AppInstance[] }> {
  if (selections.length === 0) {
    throw createError({ statusCode: 422, statusMessage: 'Choose at least one connection.' })
  }
  const options = new Map((await resolveConsentOptions(actor)).map(r => [r.instance.id, r]))
  const stored: StoredSelection[] = []
  const instances: AppInstance[] = []
  const seen = new Set<string>()
  for (const selection of selections) {
    if (seen.has(selection.connection)) continue
    seen.add(selection.connection)
    const resolved = options.get(selection.connection)
    if (!resolved) {
      throw createError({ statusCode: 404, statusMessage: 'One of those connections is no longer available to you. Reload the page.' })
    }
    const { option, ceiling, defaultScope } = resolved
    if (!ceiling || !defaultScope) {
      throw createError({ statusCode: 403, statusMessage: `“${option.connection.label}” is not enabled for sign-in. Ask an admin to allow it.` })
    }
    const scope = selection.scope ? scopeFromInput(selection.scope) : defaultScope
    if (!scopeWithin(ceiling, scope)) {
      throw createError({ statusCode: 422, statusMessage: `That asks for more of “${option.connection.label}” than an admin allows. Narrow it, or ask an admin.` })
    }
    stored.push({
      instance: resolved.instance.id,
      scope: scopeToInput(scope),
      sendDisclaimer: actor.role === 'admin' ? (selection.send_disclaimer ?? null) : (option.disclaimer ?? null),
    })
    instances.push(resolved.instance)
  }
  return { stored, instances }
}

/**
 * Approve: check what was picked, check it fits the plan, and issue a code that
 * carries it. Nothing is minted yet — the connections become token rows only
 * when the code is exchanged, so a consent the client never completes leaves
 * nothing behind.
 */
export async function approveAuthorization(
  actor: Actor,
  settings: OAuthSettings,
  request: AuthorizationRequest,
  selections: ConsentSelection[],
): Promise<string> {
  const { stored } = await validateSelections(actor, selections)
  const sql = await appDb()

  // Said here rather than as an unexplained failure in the client: the
  // exchange checks again, under the organization row lock.
  const [freedRow] = await sql<{ freed: number }[]>`
    SELECT count(*)::int AS freed FROM app.mcp_tokens t
    JOIN app.oauth_sessions s ON s.id = t.oauth_session
    WHERE s.user_id = ${actor.user.id} AND s.client = ${request.client.id} AND NOT t.revoked
  `
  await assertRoomForTokens(sql, actor.org.id, stored.length, freedRow?.freed ?? 0)

  const code = secret(CODE_PREFIX)
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO app.oauth_codes ${tx({
        code_hash: sha256(code),
        client: request.client.id,
        user_id: actor.user.id,
        selections: tx.json(stored as never),
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        resource: request.resource,
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      })}
    `
    await tx`UPDATE app.oauth_clients SET last_used_at = now() WHERE id = ${request.client.id}`
    // Expired codes are useless; sweep them while we are here rather than on a timer.
    await tx`DELETE FROM app.oauth_codes WHERE expires_at < now() - interval '1 hour'`
  })

  return buildRedirect(request.redirectUri, { code, state: request.state, iss: settings.issuer })
}

export function denyAuthorization(settings: OAuthSettings, request: AuthorizationRequest): string {
  return buildRedirect(request.redirectUri, {
    error: 'access_denied',
    error_description: 'The user declined.',
    state: request.state,
    iss: settings.issuer,
  })
}

// ── the token endpoint ─────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** A session nobody has refreshed for this long is over; the user signs in again. */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000

interface SessionRow {
  id: string
  user_id: string
  client: string
  refresh_hash?: string
  prev_refresh_hash?: string
  refreshed_at?: string
  created?: string
}

async function issuePair(tx: Db, sessionId: string, previousRefreshHash: string | null): Promise<TokenResponse> {
  const access = secret(ACCESS_TOKEN_PREFIX)
  const refresh = secret(REFRESH_TOKEN_PREFIX)
  await tx`
    UPDATE app.oauth_sessions SET
      token_hash = ${sha256(access)},
      access_expires_at = ${new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000)},
      refresh_hash = ${sha256(refresh)},
      prev_refresh_hash = ${previousRefreshHash},
      refreshed_at = now()
    WHERE id = ${sessionId}
  `
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: OAUTH_SCOPE }
}

/**
 * End sign-ins: delete the sessions, which cascades their connection rows, and
 * record each connection's end for the hosted outbox the way a revoke would.
 */
export async function endOAuthSessions(db: Db, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const children = await db<{ id: string, assigned_to: string, instance: string, org: string }[]>`
    SELECT t.id, t.assigned_to, t.instance, i.org
    FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
    WHERE t.oauth_session = ANY(${sessionIds}) AND NOT t.revoked
  `
  await db`DELETE FROM app.oauth_sessions WHERE id = ANY(${sessionIds})`
  for (const child of children) {
    await recordHostedEvent(db, { type: 'token.revoked', org: child.org, userId: child.assigned_to, payload: { id: child.id, connection: child.instance } })
  }
}

/**
 * `grant_type=authorization_code`.
 *
 * The code is spent by `DELETE … RETURNING` as the first statement, so two
 * exchanges of one code cannot both succeed, and a refused exchange still
 * commits that delete: refusals *return* rather than throw, because a throw
 * inside `begin` would roll the delete back and leave the code open to another
 * try.
 *
 * On success, in one transaction: an earlier sign-in by the same user from the
 * same client ends (signing in again *moves* the connector), the session is
 * created, and each picked connection becomes a child token row through
 * `createToken` with `assertCanAdd` before each — the plan limit under the
 * organization row lock, exactly as minting from the dashboard. A limit hit
 * there rolls back to a savepoint, so the session and children vanish but the
 * code stays spent.
 */
export async function exchangeAuthorizationCode(params: Record<string, unknown>): Promise<TokenResponse> {
  const code = str(params.code)
  const clientId = str(params.client_id)
  const verifier = str(params.code_verifier)
  const redirectUri = str(params.redirect_uri)
  if (!code || !clientId || !verifier) {
    throw new OAuthError(400, 'invalid_request', 'code, client_id and code_verifier are required.')
  }

  // One answer for every way a code can be wrong: which one would say
  // something about a code the caller may not hold.
  const invalid = new OAuthError(400, 'invalid_grant', 'The authorization code is invalid, expired or already used.')

  const sql = await appDb()
  const outcome = await sql.begin(async (tx): Promise<TokenResponse | OAuthError> => {
    const [spent] = await tx<{ client: string, user_id: string, selections: StoredSelection[], redirect_uri: string, code_challenge: string, resource?: string, expires_at: string }[]>`
      DELETE FROM app.oauth_codes WHERE code_hash = ${sha256(code)}
      RETURNING client, user_id, selections, redirect_uri, code_challenge, resource, expires_at
    `
    if (!spent) return invalid
    if (new Date(spent.expires_at).getTime() <= Date.now()) return invalid
    if (spent.client !== clientId) return invalid
    if (redirectUri !== undefined && redirectUri !== spent.redirect_uri) return invalid
    if (!pkceMatches(verifier, spent.code_challenge)) return invalid
    const resource = str(params.resource)
    if (resource && spent.resource && normaliseResource(resource) !== spent.resource) {
      return new OAuthError(400, 'invalid_target', 'The resource does not match the one authorized.')
    }

    // The minute since approval is long enough for a membership or a ceiling to
    // change: re-check what the user may grant now.
    const [user] = await tx<AppUser[]>`SELECT id, email, name FROM app.users WHERE id = ${spent.user_id}`
    const actor = user && await loadActor(user)
    if (!actor) return invalid
    let checked: Awaited<ReturnType<typeof validateSelections>>
    try {
      checked = await validateSelections(actor, spent.selections.map(s => ({
        connection: s.instance,
        scope: s.scope,
        send_disclaimer: s.sendDisclaimer,
      })))
    }
    catch {
      return new OAuthError(400, 'invalid_grant', 'What was approved is no longer allowed. Sign in again.')
    }
    const [client] = await tx<{ name: string }[]>`SELECT name FROM app.oauth_clients WHERE id = ${clientId}`

    try {
      return await tx.savepoint(async (sp) => {
        const previous = await sp<{ id: string }[]>`
          SELECT id FROM app.oauth_sessions WHERE user_id = ${actor.user.id} AND client = ${clientId} FOR UPDATE
        `
        await endOAuthSessions(sp, previous.map(p => p.id))

        const [session] = await sp<{ id: string }[]>`
          INSERT INTO app.oauth_sessions ${sp({ user_id: actor.user.id, client: clientId })} RETURNING id
        `
        for (const [i, selection] of checked.stored.entries()) {
          const instance = checked.instances[i]!
          await assertCanAdd(sp, actor.org.id, 'token')
          const { record } = await createToken({
            instanceId: instance.id,
            assignedTo: actor.user.id,
            createdBy: actor.user.id,
            label: client?.name || 'OAuth sign-in',
            preset: 'never',
            scope: scopeFromInput(selection.scope),
            sendDisclaimer: selection.sendDisclaimer,
            oauthSession: session!.id,
          }, sp)
          await recordHostedEvent(sp, {
            type: 'token.created',
            org: actor.org.id,
            userId: actor.user.id,
            payload: { id: record.id, connection: instance.id, kind: instance.kind, auth: 'oauth' },
          })
        }
        return await issuePair(sp, session!.id, null)
      })
    }
    catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 402) {
        return new OAuthError(400, 'invalid_grant', (error as Error).message || 'Your organization has no room for more connector tokens.')
      }
      throw error
    }
  })
  if (outcome instanceof OAuthError) throw outcome
  return outcome
}

/**
 * `grant_type=refresh_token`, rotated on every use.
 *
 * The presented token is looked up as the session's current one *or* the one
 * it replaced. The current one issues a new pair. The replaced one is reuse —
 * someone else has a copy — and ends the session: both copies die, and the user
 * signs in again. Inside a short grace window it is instead read as the client
 * racing itself, and refused without ending anything. Refusals *return* so the
 * ending commits.
 */
export async function refreshAccessToken(params: Record<string, unknown>): Promise<TokenResponse> {
  const presented = str(params.refresh_token)
  const clientId = str(params.client_id)
  if (!presented || !clientId) {
    throw new OAuthError(400, 'invalid_request', 'refresh_token and client_id are required.')
  }
  const hash = sha256(presented)
  const invalid = new OAuthError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked.')

  const sql = await appDb()
  const outcome = await sql.begin(async (tx): Promise<TokenResponse | 'refused'> => {
    const [session] = await tx<SessionRow[]>`
      SELECT id, user_id, client, refresh_hash, prev_refresh_hash, refreshed_at, created
      FROM app.oauth_sessions
      WHERE refresh_hash = ${hash} OR prev_refresh_hash = ${hash}
      FOR UPDATE
    `
    if (!session) return 'refused'
    if (session.client !== clientId) return 'refused'

    if (session.refresh_hash !== hash) {
      const age = session.refreshed_at ? Date.now() - new Date(session.refreshed_at).getTime() : Number.POSITIVE_INFINITY
      if (age > REFRESH_REUSE_GRACE_MS) {
        console.warn(`[oauth] a replaced refresh token for session ${session.id} was presented again; the session is ended`)
        await endOAuthSessions(tx, [session.id])
      }
      return 'refused'
    }

    const lastActive = new Date(session.refreshed_at ?? session.created ?? 0).getTime()
    if (Date.now() - lastActive > SESSION_IDLE_MS) {
      await endOAuthSessions(tx, [session.id])
      return 'refused'
    }

    // A session whose every connection has been revoked reaches nothing; end it
    // so the client goes back to the consent page rather than holding a token
    // that answers 401 forever.
    const [liveRow] = await tx<{ live: number }[]>`
      SELECT count(*)::int AS live FROM app.mcp_tokens WHERE oauth_session = ${session.id} AND NOT revoked
    `
    if (!liveRow?.live) {
      await endOAuthSessions(tx, [session.id])
      return 'refused'
    }

    return await issuePair(tx, session.id, hash)
  })
  if (outcome === 'refused') throw invalid
  return outcome
}

/**
 * RFC 7009. Either token of a pair ends the session — "disconnect" in a client.
 * An unknown token is answered the same 200, as the RFC requires.
 */
export async function revokeOAuthToken(params: Record<string, unknown>): Promise<Record<string, never>> {
  const presented = str(params.token)
  if (!presented) throw new OAuthError(400, 'invalid_request', 'token is required.')
  const hash = sha256(presented)

  const sql = await appDb()
  await sql.begin(async (tx) => {
    const sessions = await tx<{ id: string }[]>`
      SELECT id FROM app.oauth_sessions WHERE token_hash = ${hash} OR refresh_hash = ${hash} FOR UPDATE
    `
    await endOAuthSessions(tx, sessions.map(s => s.id))
  })
  return {}
}

// ── a user's own sign-ins ──────────────────────────────────────────────────

export interface OwnSession {
  id: string
  client: { name: string, verifiedHost?: string }
  created?: string
  lastUsedAt?: string
  connections: {
    tokenId: string
    id: string
    label: string
    kind: InstanceKind
    handle: string
    scope: ScopeInput
  }[]
}

/**
 * The signed-in user's OAuth sign-ins and the connections each covers — the
 * "connected apps" list on the profile page. Own rows only, as a predicate in
 * the query; revoked connections are left out, a sign-in with none left is
 * still listed (it ends at its next refresh) so it can be signed out now.
 */
export async function listOwnSessions(userId: string): Promise<OwnSession[]> {
  const sql = await appDb()
  const sessions = await sql<{ id: string, created?: string, last_used_at?: string, client_id: string, client_name: string, registration: 'dcr' | 'cimd' }[]>`
    SELECT s.id, s.created, s.last_used_at, c.id AS client_id, c.name AS client_name, c.registration
    FROM app.oauth_sessions s JOIN app.oauth_clients c ON c.id = s.client
    WHERE s.user_id = ${userId}
    ORDER BY s.created DESC
  `
  if (sessions.length === 0) return []
  const children = await sql<(AppInstance & { token_id: string, oauth_session: string, t_all_chats: boolean, t_chat_jids: unknown, t_all_tables: boolean, t_table_names: unknown, t_all_tools: boolean, t_tool_names: unknown })[]>`
    SELECT i.*, t.id AS token_id, t.oauth_session,
           t.all_chats AS t_all_chats, t.chat_jids AS t_chat_jids,
           t.all_tables AS t_all_tables, t.table_names AS t_table_names,
           t.all_tools AS t_all_tools, t.tool_names AS t_tool_names
    FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
    WHERE t.oauth_session = ANY(${sessions.map(s => s.id)}) AND NOT t.revoked
    ORDER BY t.created
  `
  return sessions.map(session => ({
    id: session.id,
    client: {
      name: session.client_name,
      verifiedHost: session.registration === 'cimd' ? new URL(session.client_id).host : undefined,
    },
    created: session.created,
    lastUsedAt: session.last_used_at,
    connections: children
      .filter(c => c.oauth_session === session.id && isSupportedInstance(c))
      .map((c) => {
        const instance = toPublicInstance(c)
        return {
          tokenId: c.token_id,
          id: c.id,
          label: instance.label,
          kind: instance.kind,
          handle: c.handle,
          scope: scopeToInput(scopeFromRecord({
            all_chats: c.t_all_chats, chat_jids: c.t_chat_jids,
            all_tables: c.t_all_tables, table_names: c.t_table_names,
            all_tools: c.t_all_tools, tool_names: c.t_tool_names,
          })),
        }
      }),
  }))
}

/** Sign one of the user's own sign-ins out. 404 for anyone else's — it does not exist for them. */
export async function endOwnSession(userId: string, sessionId: string): Promise<void> {
  const sql = await appDb()
  const ended = await sql.begin(async (tx) => {
    const [own] = await tx<{ id: string }[]>`
      SELECT id FROM app.oauth_sessions WHERE id = ${sessionId} AND user_id = ${userId} FOR UPDATE
    `
    if (!own) return false
    await endOAuthSessions(tx, [own.id])
    return true
  })
  if (!ended) throw createError({ statusCode: 404, statusMessage: 'Not found' })
}

/**
 * Add a connection to one of the user's existing sign-ins — the incremental
 * consent the MCP spec describes, done from this app rather than by sending the
 * client through authorization again.
 *
 * The same checks as the consent page (`validateSelections`: reach, the
 * member's ceiling, narrowing only), the same mint (`assertCanAdd` under the
 * organization row lock, then `createToken` into the session), the same hosted
 * event. The client sees the new tools the next time it lists them.
 */
export async function addConnectionToSession(actor: Actor, sessionId: string, selection: ConsentSelection): Promise<{ tokenId: string }> {
  const sql = await appDb()
  const [own] = await sql<{ id: string }[]>`
    SELECT id FROM app.oauth_sessions WHERE id = ${sessionId} AND user_id = ${actor.user.id}
  `
  if (!own) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const { stored, instances } = await validateSelections(actor, [selection])
  const chosen = stored[0]!
  const instance = instances[0]!

  return await sql.begin(async (tx) => {
    // Locked so two clicks cannot both add the connection; then the org row,
    // inside assertCanAdd.
    await tx`SELECT id FROM app.oauth_sessions WHERE id = ${sessionId} FOR UPDATE`
    const [existing] = await tx`
      SELECT 1 FROM app.mcp_tokens
      WHERE oauth_session = ${sessionId} AND instance = ${instance.id} AND NOT revoked
    `
    if (existing) {
      throw createError({ statusCode: 409, statusMessage: 'That sign-in already includes this connection.' })
    }
    await assertCanAdd(tx, actor.org.id, 'token')
    const [client] = await tx<{ name: string }[]>`
      SELECT c.name FROM app.oauth_sessions s JOIN app.oauth_clients c ON c.id = s.client WHERE s.id = ${sessionId}
    `
    const { record } = await createToken({
      instanceId: instance.id,
      assignedTo: actor.user.id,
      createdBy: actor.user.id,
      label: client?.name || 'OAuth sign-in',
      preset: 'never',
      scope: scopeFromInput(chosen.scope),
      sendDisclaimer: chosen.sendDisclaimer,
      oauthSession: sessionId,
    }, tx)
    await recordHostedEvent(tx, {
      type: 'token.created',
      org: actor.org.id,
      userId: actor.user.id,
      payload: { id: record.id, connection: instance.id, kind: instance.kind, auth: 'oauth' },
    })
    return { tokenId: record.id }
  })
}

// ── helpers for the routes ─────────────────────────────────────────────────

/**
 * The parameters an authorization request carries, read from a query or a JSON
 * body. Only the names the protocol defines, so nothing else rides through.
 */
export function authorizationParams(source: Record<string, unknown>): AuthorizationParams {
  const pick = (key: keyof AuthorizationParams) => str(source[key])
  return {
    response_type: pick('response_type'),
    client_id: pick('client_id'),
    redirect_uri: pick('redirect_uri'),
    code_challenge: pick('code_challenge'),
    code_challenge_method: pick('code_challenge_method'),
    state: pick('state'),
    resource: pick('resource'),
    scope: pick('scope'),
  }
}

/**
 * The consent POST is the one cookie-authenticated write that hands a
 * credential to a third party, so it gets one check the rest of the UI leaves to
 * `SameSite=Lax`: a browser-sent `Origin` must be this deployment's own.
 */
export function assertSameOrigin(event: H3Event, settings: OAuthSettings): void {
  const origin = getRequestHeader(event, 'origin')
  if (origin && origin !== new URL(settings.issuer).origin) {
    console.warn('[oauth] refused a consent POST from another origin')
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
}

/** The OAuth endpoints called by an MCP client rather than this app's own pages. */
export function isOAuthClientPath(path: string | undefined): boolean {
  const [pathname] = (path ?? '').split('?')
  return pathname === '/api/oauth/token'
    || pathname === '/api/oauth/register'
    || pathname === '/api/oauth/revoke'
    || pathname!.startsWith('/.well-known/')
}
