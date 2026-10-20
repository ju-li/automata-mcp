import { z } from 'zod'

/**
 * Read tool over synced headers. No body, no live call to the mail server —
 * read-email fetches one message's text when it is wanted.
 *
 * Two kinds of incompleteness are reported, as for Telegram, because they
 * differ: `hasMore` (this page is not the whole range; page on) and the sync's
 * history (older mail was never synced; no paging reaches it).
 */
export default defineKindTool({
  name: 'list-emails',
  kind: 'imap',
  title: 'List emails',
  description:
    'List one page of emails, newest first: sender, recipients, subject, date, read state and '
    + 'attachment names — no body. Pass `folder` (a path from list-mail-folders) to list one '
    + 'folder; without it every synced folder this token may read is listed, and an email filed '
    + 'in several folders appears once with each folder in `folders`. Filter with `since`/`until`, '
    + '`unread`, `flagged` and `hasAttachments`. A response is one page: when `hasMore` is true '
    + 'call again with `nextPage` and otherwise the same arguments (including `window`) until '
    + '`hasMore` is false before summarising. `covered` is the span this page actually covers; '
    + '`totalMatching` counts the emails in the request. Pass an `emailId` to read-email for the '
    + 'text. To find emails by sender, subject or words, use search-emails instead of paging.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    folder: z.string().min(1).max(1000).optional().describe('Folder path from list-mail-folders, e.g. "INBOX". Omit for every synced folder.'),
    since: z.string().optional().describe('Only emails received at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only emails received at or before this date. Pass back `window.until` from a previous page when paging a range.'),
    unread: z.boolean().optional().describe('true for unread emails only, false for read ones only'),
    flagged: z.boolean().optional().describe('true for flagged (starred) emails only'),
    hasAttachments: z.boolean().optional().describe('true for emails with attachments only'),
    limit: z.number().int().min(1).max(100).default(25).describe('How many emails to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page, counting back from the newest. Walk this up while `hasMore` is true.'),
  },
  handler: async ({ folder, since, until, unread, flagged, hasAttachments, limit, page }) => {
    const { instance, scope } = useMcpAuth()
    const { folders, allowed } = await foldersToRead(instance, scope, folder)

    // Pinned once a lower bound is named: an open upper bound is *now*, which
    // moves between pages and shifts every later page by what arrived.
    const range = {
      since: parseDateBound(since, 'since')?.toISOString(),
      until: parseDateBound(until, 'until')?.toISOString() ?? (since ? new Date().toISOString() : undefined),
    }

    const [{ rows, hasMore, total }, sync] = await Promise.all([
      listMailPage(instance, {
        folder,
        allowed,
        limit,
        page,
        since: range.since ? new Date(range.since) : undefined,
        until: range.until ? new Date(range.until) : undefined,
        unread,
        flagged,
        hasAttachments,
      }),
      mailSyncState(instance),
    ])

    const covered = coveredMailSpan(rows)
    const notes = [
      hasMore ? incompleteMailNote('list-emails', page, Boolean(range.since)) : undefined,
      !hasMore ? unsyncedHistoryNote(folders) : undefined,
      staleSyncNote(sync),
    ].filter((note): note is string => Boolean(note))

    return {
      ...(folder && { folder }),
      page,
      limit,
      count: rows.length,
      hasMore,
      ...(total !== undefined && { totalMatching: total, totalPages: Math.max(1, Math.ceil(total / limit)) }),
      ...(hasMore && { nextPage: page + 1 }),
      ...((range.since || range.until) && { window: range }),
      ...(covered && { covered }),
      ...(sync?.lastSuccessAt && { syncedAt: sync.lastSuccessAt }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      emails: rows.map(presentEmail),
    }
  },
})
