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
