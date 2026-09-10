/**
 * Reading a status code off a thrown error.
 *
 * Errors reach this app from three places that disagree about the key: h3's
 * `createError` sets `statusCode`, PocketBase's SDK sets `status`, and ofetch
 * sets both. Four call sites were each testing the pair by hand, and a site
 * that checked only one of them would silently stop recognising the case it
 * was written for — `logoutInstance` treating Evolution's "already
 * disconnected" 400 as success, say, or a 422 passthrough turning into a 503.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { status, statusCode } = error as { status?: unknown, statusCode?: unknown }
  if (typeof status === 'number') return status
  if (typeof statusCode === 'number') return statusCode
  return undefined
}
