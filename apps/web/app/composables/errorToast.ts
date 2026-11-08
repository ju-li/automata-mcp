import type { Ref } from 'vue'
import { markRaw } from 'vue'
import { toast } from 'vue-sonner'
import ErrorToastBody from '~/components/ErrorToastBody.vue'

/**
 * Every error toast in the app, and the bookkeeping that lets the global
 * handler (`plugins/error-toasts.client.ts`) report everything nobody else did
 * without reporting anything twice.
 *
 * **Who reports what.** A handler that catches an error owns it: it toasts
 * through `showErrorToast` (or `toastApiError` / `useApiAction`, which call it), or
 * shows it inline through `apiErrorMessage`, or decides it is not worth a word.
 * The global handler reports only what nobody caught — an uncaught rejection, an
 * error thrown in a component, and every `useFetch` / `useAsyncData` failure,
 * which never throws and so is never caught. A page that renders a fetch's
 * error itself says so with `handlesErrorItself`.
 */

const handled = new WeakSet<object>()

/** Keep the global handler off this error: whoever called this has dealt with it. */
export function markErrorHandled(error: unknown): void {
  if (error && typeof error === 'object') handled.add(error)
  // A useFetch error is a NuxtError wrapping the FetchError; either may be what
  // the global handler sees first.
  const cause = (error as { cause?: unknown } | null)?.cause
  if (cause && typeof cause === 'object') handled.add(cause)
}

export function isErrorHandled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const cause = (error as { cause?: unknown }).cause
  return handled.has(error) || (Boolean(cause) && typeof cause === 'object' && handled.has(cause as object))
}

/**
 * This component renders `error` itself — a 404 page, an "invitation is not
 * valid" card — so a toast on top would say the same thing twice.
 *
 * `flush: 'sync'` marks the error the moment the ref holds it; `immediate`
 * covers one that arrived with the server-rendered payload. The global handler
 * waits for `page:finish` before looking, so a call after `await useFetch`
 * still lands first.
 */
export function handlesErrorItself(error: Ref<unknown>): void {
  watch(error, (value) => { if (value) markErrorHandled(value) }, { immediate: true, flush: 'sync' })
}

/** When a background failure was last shown, by what it said — see `background`. */
const lastShown = new Map<string, number>()
const BACKGROUND_REPEAT_MS = 60_000

export interface ErrorToastOptions {
  /**
   * What was being attempted, as the toast's title — "Could not create the
   * connection". The server's own message then sits under it. Without one, the
   * server's message is the title.
   */
  title?: string
  /** A button on the toast, e.g. "See plans" for a plan limit. */
  action?: { label: string, onClick: () => void }
  /**
   * Nobody pressed anything: a `useFetch` that failed, a poll. The same failure
   * is then shown at most once a minute, so a dashboard polling a dead backend
   * every two seconds raises one toast, not a stack — and does not bring back
   * one the user dismissed. A failure the user caused by pressing a button
   * always shows.
   */
  background?: boolean
  /**
   * Leave the server's sentence out: it is worse than `title` ("Not found" for
   * "Could not remove the account"). The status and request line still show.
   */
  hideServerMessage?: boolean
}

/** Show `error` as a toast with its details, and mark it handled. */
export function showErrorToast(error: unknown, options: ErrorToastOptions = {}): void {
  markErrorHandled(error)

  const found = errorDetails(error, options.title)
  const details = options.hideServerMessage && options.title ? { ...found, message: options.title } : found
  const signature = [details.status ?? (details.network ? 'network' : 'error'), details.method, details.path, details.message].join(' ')

  if (options.background) {
    const last = lastShown.get(signature)
    if (last !== undefined && Date.now() - last < BACKGROUND_REPEAT_MS) return
  }
  lastShown.set(signature, Date.now())

  const title = options.title ?? details.message
  toast.error(title, {
    // One toast per distinct failure: a repeat replaces the one on screen
    // rather than stacking a copy beneath it.
    id: `error:${signature}`,
    description: markRaw(ErrorToastBody),
    componentProps: { details, title },
    // Long enough to read a sentence and press Details; the close button is
    // there for anyone done sooner.
    duration: 12_000,
    closeButton: true,
    ...(options.action && { action: options.action }),
  })
}
