import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AppInstance, AppMcpToken, Db } from './app-db'
import type { Actor } from './org'
import type { InstanceKind } from './mcp-scope'

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
    resource_name: 'Automata MCP',
  }
}

/** RFC 8414. Authorization code + PKCE (S256) + refresh, public clients only. */
export function authorizationServerMetadata(settings: OAuthSettings) {
  return {
    issuer: settings.issuer,
    authorization_endpoint: `${settings.issuer}/oauth/authorize`,
    token_endpoint: `${settings.issuer}/api/oauth/token`,
    registration_endpoint: `${settings.issuer}/api/oauth/register`,
    revocation_endpoint: `${settings.issuer}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
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

  const id = CLIENT_PREFIX + randomBytes(16).toString('base64url')
  const sql = await appDb()
  const [client] = await sql<OAuthClient[]>`
    INSERT INTO app.oauth_clients ${sql({ id, name, redirect_uris: uris })}
    RETURNING id, name, redirect_uris, created
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
  }
}

async function getClient(db: Db, id: string | undefined): Promise<OAuthClient | undefined> {
  if (!id) return undefined
  const [client] = await db<OAuthClient[]>`
    SELECT id, name, redirect_uris, created FROM app.oauth_clients WHERE id = ${id}
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
  const client = await getClient(sql, str(params.client_id))
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

export interface ClaimableGrant {
  id: string
  label: string
  created?: string
  expiresAt?: string
  /** A client already holds it; approving moves it to this one. */
  claimedBy?: string
  connection: { id: string, label: string, kind: InstanceKind }
  scope: ReturnType<typeof scopeToInput>
}

/**
 * The OAuth grants the signed-in user may claim: issued to them, alive, on a
 * connection of their organization they still reach. A predicate in the query
 * for the first three; `authorizesInstance` for the last, the same rule both
 * surfaces share.
 */
export async function listClaimableGrants(actor: Actor): Promise<ClaimableGrant[]> {
  const sql = await appDb()
  const rows = await sql<(AppMcpToken & { client_name?: string, assigned: boolean })[]>`
    SELECT t.*, c.name AS client_name,
           EXISTS (
             SELECT 1 FROM app.instance_assignments a
             WHERE a.user_id = t.assigned_to AND a.instance = t.instance
           ) AS assigned
    FROM app.mcp_tokens t
    JOIN app.instances i ON i.id = t.instance
    LEFT JOIN app.oauth_clients c ON c.id = t.oauth_client
    WHERE t.assigned_to = ${actor.user.id}
      AND t.auth_method = 'oauth'
      AND NOT t.revoked
      AND (t.expires_at IS NULL OR t.expires_at > now())
      AND i.org = ${actor.org.id}
    ORDER BY t.claimed_at IS NOT NULL, t.created DESC
  `
  if (rows.length === 0) return []

  const instances = await sql<AppInstance[]>`
    SELECT * FROM app.instances WHERE id = ANY(${[...new Set(rows.map(r => r.instance))]})
  `
  const byId = new Map(instances.map(i => [i.id, i]))

  const grants: ClaimableGrant[] = []
  for (const row of rows) {
    const instance = byId.get(row.instance)
    if (!instance || !isSupportedInstance(instance)) continue
    if (!authorizesInstance({ role: actor.role, orgId: actor.org.id }, instance.org, row.assigned)) continue
    const publicInstance = toPublicInstance(instance)
    grants.push({
      id: row.id,
      label: row.label || 'Untitled connector',
      created: row.created,
      expiresAt: row.expires_at,
      claimedBy: row.claimed_at ? (row.client_name || 'another application') : undefined,
      connection: { id: instance.id, label: publicInstance.label, kind: publicInstance.kind },
      scope: scopeToInput(scopeFromRecord(row)),
    })
  }
  return grants
}

/**
 * Approve: bind one of the actor's grants to this client and issue a code.
 *
 * The claim takes the grant row `FOR UPDATE` and re-checks every condition
 * `listClaimableGrants` showed — the page is not trusted to have been fresh.
 * Claiming **clears** whatever secret the grant had, so the client that held it
 * before (re-claiming is how someone moves a connector, or recovers one whose
 * tokens the client lost) stops working at once rather than at its next refresh.
 * That is the OAuth form of "issue a new secret", which a member may already do
 * for their own token.
 */
export async function approveAuthorization(
  actor: Actor,
  settings: OAuthSettings,
  request: AuthorizationRequest,
  grantId: string,
): Promise<string> {
  const code = secret(CODE_PREFIX)
  const sql = await appDb()

  await sql.begin(async (tx) => {
    const [row] = await tx<(AppMcpToken & { assigned: boolean, instance_org?: string })[]>`
      SELECT t.*, i.org AS instance_org,
             EXISTS (
               SELECT 1 FROM app.instance_assignments a
               WHERE a.user_id = t.assigned_to AND a.instance = t.instance
             ) AS assigned
      FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
      WHERE t.id = ${grantId}
        AND t.assigned_to = ${actor.user.id}
        AND t.auth_method = 'oauth'
        AND NOT t.revoked
        AND (t.expires_at IS NULL OR t.expires_at > now())
      FOR UPDATE OF t
    `
    if (!row || !authorizesInstance({ role: actor.role, orgId: actor.org.id }, row.instance_org, row.assigned)) {
      throw createError({ statusCode: 404, statusMessage: 'That connector is no longer available to you. Reload the page.' })
    }

    await clearGrantSecrets(tx, row.id)
    await tx`
      UPDATE app.mcp_tokens
      SET oauth_client = ${request.client.id}, claimed_at = now(), updated = now()
      WHERE id = ${row.id}
    `
    await tx`
      INSERT INTO app.oauth_codes ${tx({
        code_hash: sha256(code),
        token: row.id,
        client: request.client.id,
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
}

/**
 * Seconds until a new access token expires: an hour, or less when the grant
 * itself ends sooner. A grant's `expires_at` is the admin's decision and an
 * access token must not outlive it.
 */
function accessLifetime(grant: Pick<AppMcpToken, 'expires_at'>): number {
  const grantLeft = grant.expires_at
    ? Math.floor((new Date(grant.expires_at).getTime() - Date.now()) / 1000)
    : Number.POSITIVE_INFINITY
  return Math.max(1, Math.min(ACCESS_TOKEN_TTL_S, grantLeft))
}

async function issuePair(
  tx: Db,
  grant: AppMcpToken,
  previousRefreshHash: string | null,
): Promise<TokenResponse> {
  const access = secret(ACCESS_TOKEN_PREFIX)
  const refresh = secret(REFRESH_TOKEN_PREFIX)
  const expiresIn = accessLifetime(grant)
  await tx`
    UPDATE app.mcp_tokens SET
      token_hash = ${sha256(access)},
      access_expires_at = ${new Date(Date.now() + expiresIn * 1000)},
      refresh_hash = ${sha256(refresh)},
      prev_refresh_hash = ${previousRefreshHash},
      refreshed_at = ${previousRefreshHash ? new Date() : null},
      updated = now()
    WHERE id = ${grant.id}
  `
  return { access_token: access, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh }
}

function grantIsAlive(grant: AppMcpToken): boolean {
  if (grant.revoked || grant.auth_method !== 'oauth') return false
  return !grant.expires_at || new Date(grant.expires_at).getTime() > Date.now()
}

/**
 * `grant_type=authorization_code`. The code is spent by `DELETE … RETURNING`
 * as the first statement, so two exchanges of one code cannot both succeed, and
 * a refused exchange still commits that delete (see below).
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
  // Refusals *return* rather than throw, so the transaction commits and the
  // DELETE stands: a code is spent by any attempt to exchange it, right or
  // wrong. A throw inside `begin` would roll the delete back and leave the code
  // open to another try.
  const outcome = await sql.begin(async (tx): Promise<TokenResponse | OAuthError> => {
    const [spent] = await tx<{ token: string, client: string, redirect_uri: string, code_challenge: string, resource?: string, expires_at: string }[]>`
      DELETE FROM app.oauth_codes WHERE code_hash = ${sha256(code)}
      RETURNING token, client, redirect_uri, code_challenge, resource, expires_at
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

    const [grant] = await tx<AppMcpToken[]>`SELECT * FROM app.mcp_tokens WHERE id = ${spent.token} FOR UPDATE`
    if (!grant || !grantIsAlive(grant) || grant.oauth_client !== clientId) return invalid

    return await issuePair(tx, grant, null)
  })
  if (outcome instanceof OAuthError) throw outcome
  return outcome
}

/**
 * `grant_type=refresh_token`, rotated on every use.
 *
 * The presented token is looked up as the current one *or* the one it replaced.
 * The current one issues a new pair. The replaced one is reuse — someone else
 * has a copy — and signs the grant out (`clearGrantSecrets`), so both copies die
 * and only the holder signing in again revives it; the grant row itself, which
 * is an admin's decision, survives. Inside a short grace window it is instead
 * read as the client racing itself, and refused without signing anyone out.
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
  // The reuse branch *returns* rather than throws: a throw inside `begin` rolls
  // the transaction back, which would undo the very sign-out it exists to make.
  const outcome = await sql.begin(async (tx): Promise<TokenResponse | 'refused'> => {
    const [grant] = await tx<AppMcpToken[]>`
      SELECT * FROM app.mcp_tokens
      WHERE auth_method = 'oauth' AND (refresh_hash = ${hash} OR prev_refresh_hash = ${hash})
      FOR UPDATE
    `
    if (!grant) return 'refused'
    if (grant.oauth_client !== clientId) return 'refused'

    if (grant.refresh_hash !== hash) {
      const age = grant.refreshed_at ? Date.now() - new Date(grant.refreshed_at).getTime() : Number.POSITIVE_INFINITY
      if (age > REFRESH_REUSE_GRACE_MS) {
        console.warn(`[oauth] a replaced refresh token for grant ${grant.id} was presented again; the grant is signed out until its holder signs in again`)
        await clearGrantSecrets(tx, grant.id)
      }
      return 'refused'
    }

    if (!grantIsAlive(grant)) return 'refused'
    return await issuePair(tx, grant, hash)
  })
  if (outcome === 'refused') throw invalid
  return outcome
}

/**
 * RFC 7009. Either token of a pair signs the grant out — "disconnect" in a
 * client means that client stops, not that the admin's grant is destroyed. An
 * unknown token is answered the same 200, as the RFC requires.
 */
export async function revokeOAuthToken(params: Record<string, unknown>): Promise<Record<string, never>> {
  const presented = str(params.token)
  if (!presented) throw new OAuthError(400, 'invalid_request', 'token is required.')
  const hash = sha256(presented)

  const sql = await appDb()
  await sql.begin(async (tx) => {
    const [grant] = await tx<{ id: string }[]>`
      SELECT id FROM app.mcp_tokens
      WHERE auth_method = 'oauth' AND (token_hash = ${hash} OR refresh_hash = ${hash})
      FOR UPDATE
    `
    if (grant) await clearGrantSecrets(tx, grant.id)
  })
  return {}
}

/**
 * Sign a grant out: no access token, no refresh token, no outstanding code, no
 * client. It reads "Awaiting sign-in" again and its holder can claim it from any
 * client. Scope, holder and lifetime are untouched — this is rotation, not
 * revocation.
 */
export async function clearGrantSecrets(db: Db, tokenId: string): Promise<void> {
  await db`
    UPDATE app.mcp_tokens SET
      token_hash = NULL, access_expires_at = NULL,
      refresh_hash = NULL, prev_refresh_hash = NULL, refreshed_at = NULL,
      oauth_client = NULL, claimed_at = NULL, updated = now()
    WHERE id = ${tokenId} AND auth_method = 'oauth'
  `
  await db`DELETE FROM app.oauth_codes WHERE token = ${tokenId}`
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
