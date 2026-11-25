/**
 * An error whose message is safe to send to the caller, with the status to send it with.
 *
 * **Every deliberate 404 carries a `code`** (`chat_unknown`, `message_not_found`,
 * `session_unknown`, `not_found`). The one 404 without a code is the router's
 * own answer to a route this bridge does not have, and the app reads exactly
 * that as "bridge too old for this feature" (`isBridgeRouteMissing`). A 404
 * thrown here without a code would be reported to users as an outdated bridge.
 */
export class HttpError extends Error {
  readonly status: number
  /** A stable, machine-readable reason for callers that must branch on it. */
  readonly code?: string
  /** Extra fields for the answer body, for callers that act on them (e.g. a file's `size`). */
  readonly details?: Record<string, unknown>

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * The bridge is running without TELEGRAM_API_ID / TELEGRAM_API_HASH.
 *
 * 503 because nothing about the request is wrong — the service is. The `code` is
 * the contract with the app (`relayBridgeError`, `provisionTelegramInstance`),
 * which turns it into instructions for whoever runs the deployment; the status
 * alone would read as an outage.
 */
export const TELEGRAM_NOT_CONFIGURED = 'telegram_not_configured'

export function telegramNotConfigured(): HttpError {
  return new HttpError(
    503,
    'Telegram is not set up on this bridge: TELEGRAM_API_ID and TELEGRAM_API_HASH are not set. '
    + 'Create an app at my.telegram.org (API development tools), set both on the bridge service, and restart it.',
    TELEGRAM_NOT_CONFIGURED,
  )
}

/**
 * A short, loggable description of any error.
 *
 * Telegram RPC errors carry their code in `errorMessage` (`SESSION_REVOKED`,
 * `FLOOD_WAIT_17`); that is the useful part and it never contains request data.
 */
export function describeError(error: unknown): string {
  const rpc = (error as { errorMessage?: unknown } | undefined)?.errorMessage
  const message = typeof rpc === 'string' ? rpc : error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}
