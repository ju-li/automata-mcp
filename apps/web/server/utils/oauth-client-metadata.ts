import { request } from 'node:https'
import { isIP } from 'node:net'

/**
 * Client ID Metadata Documents (CIMD) — the client registration the MCP
 * authorization spec recommends since 2026-07-28, which deprecated Dynamic
 * Client Registration.
 *
 * A client's id is an `https` URL; the document at that URL names the client and
 * its redirect URIs, and must name that same URL as its `client_id`. Claude
 * uses this when the authorization server metadata advertises
 * `client_id_metadata_document_supported`. What it buys over DCR: the client is
 * identified by a domain it controls, which the consent page can show as
 * verified, rather than by a name it typed into a registration request.
 *
 * **What it costs is a fetch of an attacker-chosen URL**, which the spec calls
 * out as an SSRF risk. So:
 *   - `https` only, with a path, no credentials, no fragment;
 *   - the host goes through `assertPublicUrl` (`net-guard.ts`) like every other
 *     user-supplied host — private addresses refused unless the deployment set
 *     `NUXT_ALLOW_PRIVATE_TARGETS`, this deployment's own backends always;
 *   - the socket dials **the address that check approved** (`lookup` override),
 *     so the name cannot re-resolve somewhere else between check and connect —
 *     the rebinding window `evolution.ts` documents for `$fetch` does not exist
 *     here;
 *   - no redirects followed, 5 s timeout, 10 KB cap, `application/json` only.
 *
 * The document is cached on the `app.oauth_clients` row (registration `cimd`)
 * for an hour; a failed refresh keeps serving a cached copy younger than a day,
 * so the client's outage does not sign anyone out mid-consent.
 */

const FETCH_TIMEOUT_MS = 5_000
const MAX_DOCUMENT_BYTES = 10 * 1024
const FRESH_MS = 60 * 60 * 1000
const STALE_OK_MS = 24 * 60 * 60 * 1000

export interface ClientMetadata {
  client_id: string
  client_name?: string
  redirect_uris: string[]
}

/** Whether a `client_id` names a metadata document rather than a DCR-issued id. */
export function isMetadataClientId(clientId: string): boolean {
  return clientId.startsWith('https://')
}

/** The URL rules a CIMD `client_id` must meet before anything is fetched. */
function validClientIdUrl(clientId: string): URL | undefined {
  if (clientId.length > 2000) return undefined
  let url: URL
  try {
    url = new URL(clientId)
  }
  catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined
  if (url.pathname === '/' || url.pathname === '') return undefined
  // The URL must round-trip exactly: the document's client_id is compared as a
  // string, and a normalised spelling would be a second identity for one client.
  if (url.href !== clientId) return undefined
  return url
}

async function fetchDocument(url: URL): Promise<unknown> {
  const approved = await assertPublicUrl(url.href, 'OAuth client metadata')
  const family = isIP(approved.address) === 6 ? 6 : 4

  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeout: FETCH_TIMEOUT_MS,
      // Dial the approved address; TLS still verifies the certificate against
      // the hostname (servername defaults to it). Node calls this with
      // `all: true` when happy-eyeballs is on, expecting a list.
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address: approved.address, family }])
        else callback(null, approved.address, family)
      }) as never,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`answered ${res.statusCode}`))
        return
      }
      const type = String(res.headers['content-type'] ?? '')
      if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
        res.resume()
        reject(new Error(`answered ${type || 'no content type'}, not JSON`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_DOCUMENT_BYTES) req.destroy(new Error('document too large'))
        else chunks.push(chunk)
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        }
        catch {
          reject(new Error('document is not valid JSON'))
        }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

/** Check a fetched document against the rules; `undefined` with a logged reason when it fails. */
function parseDocument(clientId: string, raw: unknown, settings: OAuthSettings): ClientMetadata | undefined {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fail = (why: string) => {
    console.warn(`[oauth] client metadata at ${clientId} refused: ${why}`)
    return undefined
  }
  if (doc.client_id !== clientId) return fail('its client_id does not equal its URL')
  if ('client_secret' in doc) return fail('it carries a client_secret')
  const method = doc.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') return fail(`token_endpoint_auth_method ${String(method)} is not supported (public clients only)`)
  const uris = doc.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(u => typeof u === 'string' && u.length <= 2000)) {
    return fail('redirect_uris must list between 1 and 10 URLs')
  }
  const allowed = (uris as string[]).filter(uri => isAllowedRedirectUri(uri, settings))
  if (allowed.length === 0) return fail('none of its redirect URIs is accepted by this deployment')
  const name = typeof doc.client_name === 'string'
    ? doc.client_name.replace(/\p{Cc}/gu, '').trim().slice(0, 100)
    : ''
  return { client_id: clientId, client_name: name || undefined, redirect_uris: allowed }
}

interface ClientRow {
  id: string
  name: string
  redirect_uris: string[]
  registration: 'dcr' | 'cimd'
  fetched_at?: string
}

/**
 * The client a CIMD `client_id` names: from the cache while fresh, else fetched,
 * checked and cached. `undefined` when the URL is not acceptable, the document
 * cannot be had or fails a rule — the authorize page answers that with a 400 and
 * never redirects, like an unknown DCR client.
 */
export async function resolveMetadataClient(clientId: string, settings: OAuthSettings): Promise<ClientRow | undefined> {
  if (!validClientIdUrl(clientId)) return undefined
  const sql = await appDb()
  const [cached] = await sql<ClientRow[]>`
    SELECT id, name, redirect_uris, registration, fetched_at
    FROM app.oauth_clients WHERE id = ${clientId} AND registration = 'cimd'
  `
  const age = cached?.fetched_at ? Date.now() - new Date(cached.fetched_at).getTime() : Number.POSITIVE_INFINITY
  if (cached && age < FRESH_MS) return cached

  let metadata: ClientMetadata | undefined
  try {
    metadata = parseDocument(clientId, await fetchDocument(new URL(clientId)), settings)
  }
  catch (error) {
    // A guard refusal is a createError with the reason in its message; a fetch
    // failure is a plain Error. Either way, say which client and why — this is
    // invisible otherwise.
    console.warn(`[oauth] could not fetch client metadata from ${clientId}: ${(error as Error).message}`)
    if (cached && age < STALE_OK_MS) return cached
    return undefined
  }
  if (!metadata) return undefined

  const name = metadata.client_name || new URL(clientId).host
  const [row] = await sql<ClientRow[]>`
    INSERT INTO app.oauth_clients ${sql({ id: clientId, name, redirect_uris: metadata.redirect_uris, registration: 'cimd', fetched_at: new Date() })}
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, fetched_at = EXCLUDED.fetched_at
    WHERE app.oauth_clients.registration = 'cimd'
    RETURNING id, name, redirect_uris, registration, fetched_at
  `
  return row
}
