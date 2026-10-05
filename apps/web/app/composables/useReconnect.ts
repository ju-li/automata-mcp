import { useIntervalFn } from '@vueuse/core'

/**
 * How long to watch for the connection to come back after asking. The backend
 * answers the request before the socket is up, and a healthy reconnect takes
 * seconds; a minute without one means it is not coming on its own.
 */
const RECONNECT_WATCH_MS = 60_000

/**
 * Reconnecting a messaging account whose session dropped: ask once, then
 * watch. Three ways out — the session comes back, the backend gives up and the
 * panel leaves `lost` some other way, or nothing happens within the window and
 * `stalled` says so.
 *
 * Asked once, never polled into existence: for WhatsApp a reconnect builds a
 * new socket, and doing that on a timer is the pattern that gets a number
 * banned. The poll here only re-reads status.
 */
export function useReconnect(options: {
  url: () => string
  refresh: () => Promise<unknown>
  /** Whether the panel is still showing a dropped session. */
  lost: () => boolean
}) {
  const { busy, run } = useApiAction()
  const reconnecting = ref(false)
  const stalled = ref(false)
  let startedAt = 0

  const { pause, resume } = useIntervalFn(async () => {
    await options.refresh()
    // Left `lost`: the panel's own mode watch sees it — with `reconnecting`
    // still set, so it can say "Reconnected." — and calls `reset()`.
    if (!options.lost()) {
      pause()
      return
    }
    if (Date.now() - startedAt > RECONNECT_WATCH_MS) {
      pause()
      reconnecting.value = false
      stalled.value = true
    }
  }, 3000, { immediate: false })

  async function reconnect() {
    stalled.value = false

    const asked = await run(
      async () => {
        await $fetch(options.url(), { method: 'POST' })
        return true
      },
      { failure: 'Could not reconnect this account' },
    )

    if (!asked) {
      stalled.value = true
      return
    }

    reconnecting.value = true
    startedAt = Date.now()
    await options.refresh()
    if (options.lost()) resume()
  }

  /** The panel left `lost`; whatever was being watched for is over. */
  function reset() {
    pause()
    reconnecting.value = false
    stalled.value = false
  }

  return { busy, reconnecting, stalled, reconnect, reset }
}
