import type { ConnectionState } from '#shared/connection'

export type { ConnectionState }

export interface StateDisplay {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
  hint: string
}

/**
 * One place that maps a connection's state to what a person reads.
 *
 * The four states are shared by every kind so a badge needs no branching, but
 * the *hints* are kind-specific: "scan a QR code" is nonsense for a database,
 * and "not paired" is the wrong diagnosis for one that refused a login. Only the
 * hint takes the kind, and it defaults to WhatsApp so existing callers are
 * unchanged.
 *
 * "close" in particular needs translating — for WhatsApp it means "not paired",
 * not "an error".
 *
 * Which is also why `lost` is an option rather than a fifth state. A WhatsApp
 * session that dropped is `close` or `connecting` like one that was never
 * paired, and the words for those — "scan a QR code" — are the wrong
 * instruction for a phone that is still linked. The server tells the two apart
 * (`sessionLost`); this only chooses what to say.
 */
export function describeState(
  state: ConnectionState,
  kind: InstanceKind | undefined = 'whatsapp',
  options: { lost?: boolean } = {},
): StateDisplay {
  if (kind === 'whatsapp' && options.lost && state !== 'open') {
    return {
      label: 'Connection lost',
      variant: 'destructive',
      hint: 'WhatsApp dropped this account\'s connection. Evolution normally reconnects within seconds — if it stays like this, reconnect.',
    }
  }

  if (kind === 'postgres') {
    switch (state) {
      case 'open':
        return { label: 'Connected', variant: 'default', hint: 'Claude can query this database.' }
      case 'connecting':
        return { label: 'Connecting', variant: 'secondary', hint: 'Waiting for the database to answer.' }
      case 'close':
        return { label: 'Unreachable', variant: 'outline', hint: 'The database did not answer. Check the connection string and that this server can reach it.' }
      default:
        return { label: 'Unknown', variant: 'destructive', hint: 'No connection string is stored for this database.' }
    }
  }

  switch (state) {
    case 'open':
      return { label: 'Connected', variant: 'default', hint: 'This account can send and receive messages.' }
    case 'connecting':
      return { label: 'Waiting for scan', variant: 'secondary', hint: 'Scan the QR code with WhatsApp to finish pairing.' }
    case 'close':
      return { label: 'Disconnected', variant: 'outline', hint: 'Not paired with a phone. Scan a QR code to connect.' }
    default:
      return { label: 'Unknown', variant: 'destructive', hint: 'Could not reach the Evolution API for this account.' }
  }
}
