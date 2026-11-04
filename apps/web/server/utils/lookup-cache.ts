/**
 * Short-lived caches for lookups that can be unavailable rather than empty.
 *
 * The Evolution lookups that go through Baileys — a group's subject, a group's
 * participants — share an awkward shape. They are live round trips to WhatsApp,
 * so they are slow and they never answer at all while the account is
 * disconnected; they are asked for repeatedly, because a picker refetches on
 * every open and an MCP client may call `list-chats` in a loop; and their
 * answers change on a human timescale, so a stale one is nearly always right.
 *
 * Two helpers, because the callers differ in whether they can wait:
 *
 *   staleWhileFailing     the caller awaits the lookup. `fetchParticipants` in
 *                         `mentions.ts`: one group, one call, bounded by a short
 *                         timeout, and the answer it gives is the one it needs.
 *   staleWhileRevalidate  the caller never awaits it. `groupsFor` in `chats.ts`:
 *                         Evolution's `fetchAllGroups` fetches a profile picture
 *                         per group, sequentially, and on an account in fifty
 *                         groups never finishes inside any timeout a request
 *                         could afford — so it is refreshed in the background
 *                         and the request reads whatever is there.
 *
 * Three behaviours both keep, and each is load-bearing:
 *
 *   serve stale   A failed refresh keeps the value we had rather than
 *                 dropping to nothing: a name from a minute ago still beats a
 *                 raw id on screen.
 *   cache the     For a while. `findChats` and the message listing read
 *   failure       Evolution's database and keep answering while the account is
 *                 disconnected — exactly when these cannot succeed — so without
 *                 this every caller would start the lookup again.
 *   never throw   A caller must still get its messages back when nobody can be
 *                 named, so `load` reports failure as `undefined` and these
 *                 answer with `empty`.
 */
export interface StaleCacheOptions<T> {
  /** How long a good answer is served for. */
  ttlMs: number
  /** How long a failure is served for, before the lookup is tried again. */
  retryTtlMs: number
  /** Answer when a lookup fails and nothing was cached. Shared, so keep it immutable. */
  empty: T
}

/**
 * Returns the `resolve(key, load)` function to cache behind.
 *
 * `load` must resolve to `undefined` for "could not answer" and to a value for
 * "answered", including an answer that is legitimately empty — the two are not
 * the same and only the caller can tell them apart.
 */
export function staleWhileFailing<T>(options: StaleCacheOptions<T>) {
  const entries = new Map<string, { expiresAt: number, value: T }>()

  return async function resolve(key: string, load: () => Promise<T | undefined>): Promise<T> {
    const cached = entries.get(key)
    if (cached && Date.now() < cached.expiresAt) return cached.value

    const loaded = await load()

    if (loaded === undefined) {
      const value = cached?.value ?? options.empty
      entries.set(key, { expiresAt: Date.now() + options.retryTtlMs, value })
      return value
    }

    entries.set(key, { expiresAt: Date.now() + options.ttlMs, value: loaded })
    return loaded
  }
}

/**
 * Returns a synchronous `peek(key, load)`: the cached value (or `empty`) right
 * now, with a background `load` started when the entry is missing or expired.
 *
 * At most one `load` is in flight per key. Concurrent readers of a cold entry
 * all get `empty` and share the one refresh, which is the point: the first
 * `list-chats` after a deploy must not start one group scan per caller.
 *
 * A failure — `undefined` or a rejection — keeps the previous value and holds
 * off for `retryTtlMs` before the next attempt. That back-off is what keeps a
 * disconnected account from costing Evolution a full scan on every read.
 *
 * No timers: refreshes are started only by reads, so an account nobody looks at
 * costs nothing, and `load`'s own timeout is what bounds each one. Per process,
 * so every replica refreshes for itself.
 */
export function staleWhileRevalidate<T>(options: StaleCacheOptions<T>) {
  const entries = new Map<string, { expiresAt: number, value: T }>()
  const inFlight = new Set<string>()

  function settle(key: string, loaded: T | undefined) {
    if (loaded === undefined) {
      const value = entries.get(key)?.value ?? options.empty
      entries.set(key, { expiresAt: Date.now() + options.retryTtlMs, value })
      return
    }
    entries.set(key, { expiresAt: Date.now() + options.ttlMs, value: loaded })
  }

  return function peek(key: string, load: () => Promise<T | undefined>): T {
    const cached = entries.get(key)
    const fresh = cached !== undefined && Date.now() < cached.expiresAt

    if (!fresh && !inFlight.has(key)) {
      inFlight.add(key)
      // `Promise.resolve().then` so a `load` that throws synchronously is
      // caught here too, rather than escaping into the request.
      Promise.resolve()
        .then(load)
        .then(
          loaded => settle(key, loaded),
          () => settle(key, undefined),
        )
        .finally(() => inFlight.delete(key))
    }

    return cached?.value ?? options.empty
  }
}
