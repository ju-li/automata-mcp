/**
 * What the tokens table is able to show. The plaintext is returned exactly once,
 * at mint time, and only its SHA-256 hash is stored — so every URL built for an
 * existing token is a shape, not a working address.
 */
export const MASKED_TOKEN = `wamcp_${'•'.repeat(12)}`

/**
 * The one place the connector URL is built. `NUXT_PUBLIC_APP_URL` is what every
 * token handed out points at; get it wrong in one component and only that
 * component's users are misdirected.
 */
export function useConnectorUrl() {
  const config = useRuntimeConfig()

  const origin = computed(
    () => config.public.appUrl || (import.meta.client ? window.location.origin : ''),
  )

  /**
   * The path form is what most people need: Claude's custom connectors cannot
   * attach an Authorization header, so the token has to ride in the URL.
   *
   * Falls back to the mask when the token is unknown, which is every case but
   * the reveal dialog.
   */
  function connectorUrl(token?: string | null) {
    return `${origin.value}/mcp/${token || MASKED_TOKEN}`
  }

  /** For clients that can set headers — the token travels in `Authorization`. */
  const bearerUrl = computed(() => `${origin.value}/mcp`)

  return { origin, connectorUrl, bearerUrl }
}
