/**
 * Dates as the token list and its dialogs show them: "5 Nov 2026", and with the
 * time "5 Nov 2026, 14:03", in the viewer's locale and time zone.
 */
export function formatDate(value?: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** "just now", "14 min ago", "3 h ago", "5 days ago" — `now` passed in so a ticking clock can re-render it. */
export function timeAgo(value: string, now: number = Date.now()): string {
  const minutes = Math.round((now - Date.parse(value)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}
