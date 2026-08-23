export interface SessionUser {
  id: string
  email: string
  name?: string
}

/**
 * The signed-in user, shared across the app.
 *
 * The browser never talks to PocketBase — the session cookie is `httpOnly`, so
 * the only way to know who is signed in is to ask the server. This caches that
 * answer in `useState` so it survives hydration and is fetched once per load
 * rather than once per navigation.
 */
export function useSession() {
  const user = useState<SessionUser | null>('session:user', () => null)
  const loaded = useState<boolean>('session:loaded', () => false)

  async function refresh(): Promise<SessionUser | null> {
    // useRequestFetch forwards the incoming cookies during SSR; a bare $fetch
    // would make this request anonymously on the server and always see null.
    const fetchWithCookies = useRequestFetch()
    const { user: fetched } = await fetchWithCookies<{ user: SessionUser | null }>('/api/auth/me')
    user.value = fetched
    loaded.value = true
    return fetched
  }

  async function ensureLoaded(): Promise<SessionUser | null> {
    if (loaded.value) return user.value
    return await refresh()
  }

  async function logout(): Promise<void> {
    await $fetch('/api/auth/logout', { method: 'POST' })
    user.value = null
    loaded.value = true
    await navigateTo('/login')
  }

  return { user, loaded, refresh, ensureLoaded, logout }
}
