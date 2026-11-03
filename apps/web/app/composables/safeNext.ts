/** Where an MCP client sends someone to approve it. See server/utils/oauth.ts. */
export const OAUTH_CONSENT_ROUTE = '/oauth/authorize'

/**
 * The one place a post-sign-in destination is accepted from the URL, and only
 * the consent page: anything else would make `/login?next=` an open redirect.
 */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value === OAUTH_CONSENT_ROUTE || value.startsWith(`${OAUTH_CONSENT_ROUTE}?`) ? value : undefined
}
