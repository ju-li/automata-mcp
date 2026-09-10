/**
 * The connection shape the UI works with, mirroring `toPublicInstance` on the
 * server. Kept in one place so a card, a listing and a dashboard cannot disagree
 * about what a connection is.
 */
export type InstanceKind = 'whatsapp' | 'postgres'

export interface PublicInstanceRow {
  id: string
  kind: InstanceKind
  name: string
  label: string
  created?: string
  /** Where it points, for display. Never credentials. */
  target?: string
  /** WhatsApp only: true when it uses an Evolution server the user supplied. */
  ownServer?: boolean
  /** WhatsApp only: whether the read tools can answer for this connection. */
  canReadMessages?: boolean
}

/** What to call this kind of connection in prose, singular. */
export function describeKind(kind: InstanceKind): string {
  return kind === 'postgres' ? 'database' : 'WhatsApp account'
}

/**
 * The message to show for a failed `$fetch`.
 *
 * `data.message` first, deliberately: the server puts its actual diagnosis
 * there — which host was refused, which database answered, which SQLSTATE — and
 * `statusMessage` is the generic. Five call sites had drifted into three
 * different orderings of these two keys, so the same failure read differently
 * depending on which component you were looking at.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: { message?: string, statusMessage?: string } })?.data
  return data?.message || data?.statusMessage || fallback
}
