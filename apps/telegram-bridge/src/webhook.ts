const TIMEOUT_MS = 5_000

/**
 * POST one event to the URL a session registered.
 *
 * The payload is a hint, not a fact — the app answers it with a live read of
 * `/state` — so a delivery that fails is logged and not retried. The app's own
 * hourly sweep is what makes a lost delivery late rather than missed.
 *
 * Redirects are not followed: the registered URL is the destination, and the
 * headers (which carry the app's webhook secret) must not follow a 30x elsewhere.
 */
export async function deliverWebhook(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`webhook answered ${response.status}`)
}
