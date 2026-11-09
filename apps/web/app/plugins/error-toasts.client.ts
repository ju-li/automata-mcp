/**
 * The app-wide error net: anything that fails without anyone reporting it
 * becomes an error toast (`showErrorToast`), so a failure is never silent.
 *
 * Three ways in, because no single hook sees everything:
 *
 *   1. `useFetch` / `useAsyncData` never throw — a failure lands in
 *      `nuxtApp.payload._errors[key]` and stays there, so no `catch` and no Vue
 *      error hook ever sees it. That map is a `shallowReactive` Nuxt fills on
 *      the server too (serialised into the payload), so watching it after mount
 *      covers both a failed refresh and a page that was rendered already
 *      failing. `_errors` is Nuxt-internal: **a Nuxt bump = re-check**
 *      `buildAsyncData` in `nuxt/dist/app/composables/asyncData.js` still keeps
 *      errors there (verified on 4.5.2).
 *   2. `vue:error` — thrown in a component: render, lifecycle, watcher, or an
 *      async `@click` handler, whose rejection Vue routes here.
 *   3. `unhandledrejection` — a promise nobody awaited or caught: a timer or an
 *      interval callback, outside Vue's error handling.
 *
 * What it leaves alone, each for a reason:
 *
 *   - an error someone already handled (`markErrorHandled`): `showErrorToast`,
 *     `toastApiError`, `useApiAction` and `apiErrorMessage` all mark, and a page
 *     rendering a fetch error itself calls `handlesErrorItself`. The `useFetch`
 *     check is deferred one task so those get there first;
 *   - 401: the session gate (`auth.global.ts`) owns being signed out, and a
 *     toast saying so on the login page would be noise;
 *   - an aborted request: a newer one replaced it.
 *
 * Every report here is `background`, so a poll against a dead backend raises
 * one toast a minute, not one every two seconds.
 */
export default defineNuxtPlugin((nuxtApp) => {
  function isAbort(error: object): boolean {
    const e = error as { name?: string, cause?: { name?: string } }
    return e.name === 'AbortError' || e.cause?.name === 'AbortError'
  }

  function report(error: unknown): void {
    if (!error || typeof error !== 'object' || isAbort(error) || isErrorHandled(error)) return
    // The status as `errorDetails` reads it, so a wrapped or serialised 401
    // counts as one too.
    const details = errorDetails(error)
    if (details.status === 401) return
    // A bug's own message ("Cannot read properties of undefined") is detail,
    // not a headline a person can act on.
    const isRequest = details.status !== undefined || details.network || details.path !== undefined
    showErrorToast(error, { background: true, ...(!isRequest && { title: 'Something went wrong on this page' }) })
  }

  // No separate "already checked" set: an error once toasted is marked handled
  // by showErrorToast, so a later pass skips it in report().
  function checkFetchErrors(): void {
    setTimeout(() => {
      for (const error of Object.values(nuxtApp.payload._errors ?? {})) report(error)
    }, 0)
  }

  // Not before the page has settled. A fetch that failed during SSR has no
  // cached data, so hydration runs it again and the page's setup resumes after
  // `await useFetch` — and calls `handlesErrorItself` — only once that second
  // request is back, which is after `app:mounted`. Checking then toasted the
  // connection page's own 404 under its own explanation. While a page is
  // loading, errors wait for `page:finish`; after it, a failed refresh or lazy
  // fetch is checked one task later.
  let settled = false
  const settle = () => {
    settled = true
    checkFetchErrors()
  }
  nuxtApp.hook('page:start', () => { settled = false })
  nuxtApp.hook('page:finish', settle)
  nuxtApp.hook('app:suspense:resolve', settle)
  watch(() => ({ ...nuxtApp.payload._errors }), () => { if (settled) checkFetchErrors() })

  nuxtApp.hook('vue:error', (error) => {
    report(error)
  })

  window.addEventListener('unhandledrejection', (event) => {
    report(event.reason)
  })
})
