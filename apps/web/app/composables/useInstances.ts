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
}

/** What to call this kind of connection in prose, singular. */
export function describeKind(kind: InstanceKind): string {
  return kind === 'postgres' ? 'database' : 'WhatsApp account'
}
