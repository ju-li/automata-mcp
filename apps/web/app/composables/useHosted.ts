/**
 * Whether this deployment is the hosted offering, from `/api/hosted`. False on
 * every self-hosted deployment, and while the answer is unknown, so nothing
 * hosted-only flashes onto a self-hosted page.
 *
 * One fetch per page load: the shared key and `getCachedData` let every
 * caller after the first reuse its answer.
 */
export function useHosted() {
  const { data } = useFetch<{ hosted: boolean }>('/api/hosted', {
    key: 'hosted',
    getCachedData: (key, nuxtApp) => nuxtApp.payload.data[key] ?? nuxtApp.static.data[key],
  })
  return computed(() => Boolean(data.value?.hosted))
}
