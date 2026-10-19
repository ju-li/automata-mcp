/**
 * What this browser is waiting to verify, for the verify page. `{ pending: null }`
 * when nothing is — the cookie is gone, the row expired or ran out of attempts.
 */
export default defineEventHandler(async (event) => {
  const row = await resolvePendingVerification(event)
  return { pending: row ? { purpose: row.purpose, email: row.email } : null }
})
