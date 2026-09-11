import type { InstanceKind } from '#shared/connection'

/**
 * The connection shape the UI works with, mirroring `toPublicInstance` on the
 * server. Kept in one place so a card, a listing and a dashboard cannot disagree
 * about what a connection is.
 *
 * `InstanceKind` itself is shared with the server — see `shared/connection.ts`.
 */
export type { InstanceKind }

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

/**
 * One connection in the listing, as `/api/instances` returns it: a
 * `PublicInstanceRow` plus the live state the route resolves per kind.
 *
 * Declared once because the page and the card were carrying identical copies,
 * field for field — and a field added to only one of them is a silent gap
 * rather than a type error.
 */
export interface InstanceListRow {
  id: string
  kind: InstanceKind
  label: string
  state: ConnectionState
  /** WhatsApp only: was connected, and Evolution's live socket no longer is. */
  sessionLost?: boolean
  target?: string
  detail?: string
  profileName?: string
  number?: string
  /** WhatsApp only. Absent for kinds with no message counts. */
  stats?: { messages: number, chats: number, contacts: number }
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
