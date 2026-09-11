import { toast } from 'vue-sonner'

/**
 * One button-press against the API: a busy flag, a toast either way.
 *
 * This shape — set a flag, `$fetch`, refresh, toast, clear the flag in a
 * `finally` — was written out nine times across the two dashboard panels, the
 * token list and the auth pages. Each copy was correct, and each was one edit
 * away from forgetting the `finally` and leaving a button disabled for good.
 *
 * Two things the copies did NOT agree on are kept as choices rather than
 * flattened:
 *
 *   `preferServerMessage`  Most failures are worth reporting in the server's own
 *                          words — which host was refused, which database
 *                          answered, which SQLSTATE. A few are not: "Not found"
 *                          is a worse thing to show someone than "Could not
 *                          remove the account". Defaults to the server's
 *                          message, since that is both the majority and the case
 *                          the call sites argued for in comments.
 *   `keepBusyOnSuccess`    An action that navigates away must stay busy: clearing
 *                          the flag re-enables a button on a page that is being
 *                          torn down, which flickers.
 */
export function useApiAction() {
  const busy = ref(false)

  async function run<T>(
    work: () => Promise<T>,
    options: {
      success?: string
      failure: string
      preferServerMessage?: boolean
      keepBusyOnSuccess?: boolean
    },
  ): Promise<T | undefined> {
    busy.value = true

    try {
      const result = await work()
      if (options.success) toast.success(options.success)
      if (!options.keepBusyOnSuccess) busy.value = false
      return result
    }
    catch (error) {
      toast.error(
        options.preferServerMessage === false
          ? options.failure
          : apiErrorMessage(error, options.failure),
      )
      busy.value = false
      return undefined
    }
  }

  return { busy, run }
}
