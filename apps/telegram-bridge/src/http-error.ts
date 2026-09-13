/** An error whose message is safe to send to the caller, with the status to send it with. */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
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
