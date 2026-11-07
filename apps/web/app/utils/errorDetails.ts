/**
 * What a failure says about itself, in one shape the error toast renders and a
 * person can copy into a bug report.
 *
 * Three shapes reach it:
 *
 *   - ofetch's `FetchError`, from `$fetch` in a handler: `response`, `request`
 *     and `options.method` are all there;
 *   - the `NuxtError` that `useFetch` / `useAsyncData` store: on the client its
 *     `cause` is that `FetchError`, but one rendered on the server arrives
 *     serialised with only `statusCode`, `message` and `data` — so the method and
 *     path are read back out of ofetch's message, `[GET] "/api/…": 422 …`;
 *   - anything else thrown — a bug, a browser API refusing — which has a message
 *     and nothing else.
 *
 * **Never reads the request body.** A create call carries a DSN, an IMAP
 * password or a Telegram 2FA password, and "Copy details" must not put one on
 * the clipboard to be pasted into a ticket. The query string is dropped from
 * the path for the same reason, a search term being the least of what one can
 * hold.
 */
export interface ErrorDetails {
  /** The server's own words, else the caller's fallback. */
  message: string
  status?: number
  /** The standard reason phrase. HTTP/2 sends none, so it is looked up, not read. */
  statusText?: string
  method?: string
  path?: string
  /** The app's machine-readable code, `data.code` on the error body (`plan_limit`, `pg_connect_failed`). */
  code?: string
  /** What underneath refused — a SQLSTATE or socket error code — when the server named one. */
  reason?: string
  /** No response at all: offline, DNS, the server down or restarting. */
  network: boolean
  at: string
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** ofetch's message: `[POST] "/api/instances": 422 Unprocessable Content`. */
const FETCH_MESSAGE = /^\[(\w+)\] "([^"]+)"(?::\s*(\d{3}))?/

interface Loose {
  name?: string
  message?: string
  statusCode?: number
  status?: number
  data?: unknown
  cause?: unknown
  request?: unknown
  response?: { status?: number, _data?: unknown }
  options?: { method?: string }
}

interface ErrorBody {
  message?: string
  statusMessage?: string
  url?: string
  data?: { code?: unknown, reason?: unknown }
}

function pathOf(url: string): string | undefined {
  try {
    const parsed = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.origin)
    return parsed.pathname
  }
  catch {
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function errorDetails(error: unknown, fallback = 'Something went wrong'): ErrorDetails {
  const outer = (error ?? {}) as Loose
  const cause = (outer.cause ?? {}) as Loose
  // The FetchError, wherever it sits: thrown directly, or as a NuxtError's cause.
  const fetchError = outer.request !== undefined || outer.response !== undefined
    ? outer
    : cause.request !== undefined || cause.response !== undefined ? cause : undefined

  const rawBody = outer.data ?? fetchError?.data ?? fetchError?.response?._data
  const body: ErrorBody = rawBody && typeof rawBody === 'object' ? rawBody as ErrorBody : {}

  const parsed = FETCH_MESSAGE.exec(outer.message ?? '') ?? FETCH_MESSAGE.exec(cause.message ?? '')

  const status = fetchError?.response?.status
    ?? outer.statusCode
    ?? (parsed?.[3] ? Number(parsed[3]) : undefined)
  // A NuxtError defaults to 500 even when the request never got an answer, so
  // only a real response, or ofetch saying it had one, counts as one.
  const answered = fetchError ? fetchError.response !== undefined : parsed ? Boolean(parsed[3]) : status !== undefined
  const isFetch = Boolean(fetchError || parsed || outer.name === 'FetchError')
  const network = isFetch && !answered

  const request = fetchError?.request
  const requestUrl = typeof request === 'string'
    ? request
    : request && typeof request === 'object' && 'url' in request ? String((request as { url: unknown }).url) : undefined
  const path = (requestUrl && pathOf(requestUrl)) ?? (parsed?.[2] && pathOf(parsed[2])) ?? (body.url && pathOf(body.url))
  const method = (fetchError?.options?.method ?? parsed?.[1] ?? (path ? 'GET' : undefined))?.toUpperCase()

  const serverMessage = asString(body.message) ?? asString(body.statusMessage)
  const message = serverMessage
    ?? (network ? 'Could not reach the server. Check your connection, then try again.' : undefined)
    // ofetch's own message is a debugging line, not a sentence for a person.
    ?? (isFetch ? undefined : asString(outer.message))
    ?? fallback

  return {
    message,
    status: answered ? status : undefined,
    statusText: answered && status ? STATUS_TEXT[status] : undefined,
    method,
    path,
    code: asString(body.data?.code),
    reason: asString(body.data?.reason),
    network,
    at: new Date().toISOString(),
  }
}

/** Plain text for the clipboard. Holds nothing `errorDetails` would not show. */
export function errorDetailsText(details: ErrorDetails, title?: string): string {
  return [
    title && title !== details.message ? title : undefined,
    details.message,
    details.status ? `Status: ${details.status}${details.statusText ? ` ${details.statusText}` : ''}` : details.network ? 'Status: no response' : undefined,
    details.path ? `Request: ${details.method ?? 'GET'} ${details.path}` : undefined,
    details.code ? `Code: ${details.code}` : undefined,
    details.reason ? `Reason: ${details.reason}` : undefined,
    typeof location === 'undefined' ? undefined : `Page: ${location.pathname}`,
    `Time: ${details.at}`,
  ].filter(Boolean).join('\n')
}
