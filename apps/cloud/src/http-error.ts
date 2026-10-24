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
 * The service is running without Stripe keys. 503 because nothing about the
 * request is wrong — the service is.
 */
export function billingNotConfigured(): HttpError {
  return new HttpError(503, 'Billing is not available right now.', 'billing_not_configured')
}

/** A short, loggable description of any error. Never contains request data. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 300)
}
