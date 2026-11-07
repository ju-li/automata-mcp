/**
 * Hard deadlines for work that waits on a server someone else runs.
 *
 * A bring-your-own Evolution server or Telegram bridge is an address an
 * organization admin chose, and any self-signup is one (GHSA-g2cf-mx92-xc53).
 * Such a server can answer `200` with its headers straight away and then send
 * the body one byte at a time, for ever. Two things this deployment relied on
 * do not stop that:
 *
 * - **ofetch's `timeout` covers the headers only.** ofetch 1.5.1 arms an
 *   `AbortController` for `timeout` and clears it in a `finally` as soon as
 *   `fetch()` resolves — at the headers — and reads the body after that
 *   with nothing armed. Undici's own body timeout is an *idle* timer, which a
 *   trickle of one byte a second keeps resetting. Hence `applyRequestDeadline`:
 *   a signal set in `onRequest` runs before ofetch's timeout logic (which then
 *   stands aside, since a signal exists) and stays attached to the response
 *   stream until the body is read, so it bounds request *and* body.
 * - **`.catch()` handles rejection, not a promise that never settles.** A
 *   scheduled task that awaits each connection in turn stalls at the first one
 *   that hangs, and Nitro 2.13's `runTask` hands every later tick the same
 *   pending promise, so no new run starts until the process restarts — every
 *   other tenant's disconnect alerts silently stop. Hence `forEachBounded`: each
 *   item gets its own deadline, so one tenant's server delays only its own item.
 *
 * Both are needed. The request deadline makes the promise settle; the per-item
 * deadline is what holds for everything the request deadline cannot reach —
 * a user-supplied message database that trickles its rows, say, where
 * postgres.js has no client-side query timeout.
 */

/**
 * Default end-to-end deadline for one HTTP request to an Evolution server or a
 * Telegram bridge, body included. A caller passing `timeout` gets that instead,
 * end to end as well — never less protection than it asked for.
 */
export const OUTBOUND_REQUEST_DEADLINE_MS = 30_000

/**
 * How long one connection's work in a scheduled task may take: a status read
 * can make two requests back to back (a live read, then an API row read), and
 * what follows — mail, a delete — needs room too. Derived, so it moves with
 * the request deadline.
 */
export const CONNECTION_WORK_DEADLINE_MS = 3 * OUTBOUND_REQUEST_DEADLINE_MS

/**
 * For an ofetch `onRequest` hook: arm a fresh deadline covering the whole
 * request, response body included, for this one request.
 *
 * Fresh per request, never one signal shared by a client: `AbortSignal.timeout`
 * starts counting when created, so a shared one would expire every later
 * request on that client at once.
 */
export function applyRequestDeadline(
  options: { signal?: AbortSignal | null, timeout?: number },
  fallbackMs = OUTBOUND_REQUEST_DEADLINE_MS,
): void {
  const ms = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : fallbackMs
  const deadline = AbortSignal.timeout(ms)
  // A caller's own signal still works; whichever fires first wins.
  options.signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
}

export class DeadlineExceededError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${Math.round(ms / 1000)} s`)
    this.name = 'DeadlineExceededError'
  }
}

/**
 * Settle within `ms`, rejecting with `DeadlineExceededError` otherwise.
 *
 * This stops the *waiting*, not the work: `work` keeps running and may still
 * finish later. Use it where moving on matters more than the outcome — and
 * where a late finish is harmless, which every caller here has checked.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(what, ms)), ms)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

/**
 * Run `work` over `items` with at most `concurrency` at once, each bounded by
 * `deadlineMs`. Never rejects: a failure or a missed deadline is passed to
 * `onError` for that item and the rest carry on.
 *
 * The bound is what makes a scheduled task over tenants' servers safe; the
 * concurrency keeps a handful of slow servers from adding their deadlines up
 * into a run longer than the task's own interval.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  options: {
    concurrency: number
    deadlineMs: number
    what: (item: T) => string
    onError: (item: T, error: unknown) => void
  },
  work: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!
      try {
        await withDeadline(work(item), options.deadlineMs, options.what(item))
      }
      catch (error) {
        options.onError(item, error)
      }
    }
  }
  const workers = Math.max(1, Math.min(options.concurrency, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
}
