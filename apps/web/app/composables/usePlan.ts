import { toast } from 'vue-sonner'

/**
 * The organization's plan, as `/api/auth/me` reported it.
 *
 * `plan` is the plan's display name, and `undefined` on a deployment without
 * the hosted offering — every self-hosted one — where nothing that reads this
 * may show a plan, a limit or a Billing link. `limited` says the organization
 * has limits at all; it knows numbers, not plan names. It gates UI only: every limit is enforced by the server, which answers
 * 402 `plan_limit` whatever the browser shows.
 */
export function usePlan() {
  const { membership } = useSession()
  const plan = computed(() => membership.value?.org.plan)
  return {
    plan,
    billing: computed(() => Boolean(plan.value)),
    limited: computed(() => Boolean(membership.value?.org.limited)),
    overLimit: computed(() => Boolean(membership.value?.org.overLimit)),
  }
}

/** The server refused because the plan has no room — `assertCanAdd` in entitlements.ts. */
export function isPlanLimitError(error: unknown): boolean {
  const body = (error as { data?: { data?: { code?: unknown } } })?.data
  return body?.data?.code === 'plan_limit'
}

/**
 * Toast a failed request, offering the Billing page when the plan was the
 * reason. Admins only get the link: a member cannot upgrade, and a button they
 * cannot use is worse than none. `isAdmin` is read by the caller during setup —
 * this runs in a `catch`, after an `await`, where composables are unsafe.
 */
export function toastApiError(
  error: unknown,
  fallback: string,
  options: { preferServerMessage?: boolean, isAdmin?: boolean } = {},
): void {
  const message = options.preferServerMessage === false && !isPlanLimitError(error)
    ? fallback
    : apiErrorMessage(error, fallback)

  if (isPlanLimitError(error) && options.isAdmin) {
    toast.error(message, { action: { label: 'See plans', onClick: () => navigateTo('/billing') } })
    return
  }
  toast.error(message)
}

/** Send the browser to Stripe Checkout for Pro. Answers false when it could not. */
export async function startCheckout(): Promise<boolean> {
  try {
    const { url } = await $fetch<{ url: string }>('/api/billing/checkout', { method: 'POST' })
    window.location.assign(url)
    return true
  }
  catch (error) {
    toast.error(apiErrorMessage(error, 'Could not start checkout'))
    return false
  }
}
