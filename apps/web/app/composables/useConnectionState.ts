export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

export interface StateDisplay {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
  hint: string
}

/**
 * One place that maps Evolution's connection states to what a person reads.
 * "close" in particular needs translating — it means "not paired", not "an error".
 */
export function describeState(state: ConnectionState): StateDisplay {
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
