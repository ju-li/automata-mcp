/** An error whose message is safe to send to the caller, with the status to send it with. */
export class HttpError extends Error {
  readonly status: number
  /** A stable, machine-readable reason for callers that must branch on it. */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
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
