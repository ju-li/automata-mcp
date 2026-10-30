import { z } from 'zod'

const DEFAULT_CHARS = 20_000

/**
 * The one tool that fetches a body. Headers come from the synced row; the text
 * is downloaded from the mail server for this call and kept nowhere. The
 * folder is opened read-only and the part fetched with BODY.PEEK, so reading
 * an email here does not mark it read for its owner.
 */
export default defineKindTool({
  name: 'read-email',
  kind: 'imap',
  title: 'Read email',
  description:
    'Read one email: its headers, its body as plain text (HTML is converted), and its attachment '
    + 'list. Takes an `emailId` from list-emails or search-emails, unchanged. Long bodies come back '
    + 'in pieces: when `truncated` is true call again with `offset: nextOffset` for the rest. '
    + 'Attachments are listed by `part`; fetch one with get-email-attachment only when its content '
    + 'is needed. `messageId`, `inReplyTo` and `references` identify the email in its thread — '
    + 'search-emails by subject finds the rest of a conversation.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    emailId: z.string().min(1).max(2000).describe('An emailId from list-emails or search-emails'),
    offset: z.number().int().min(0).default(0).describe('Character offset into the body, for continuing a truncated one'),
    maxChars: z.number().int().min(500).max(100_000).default(DEFAULT_CHARS).describe('Most body characters to return'),
  },
  handler: async ({ emailId, offset, maxChars }) => {
    const { instance, scope } = useMcpAuth()
    const ref = decodeEmailId(emailId)
    assertFolderAllowed(scope, ref.folderPath)

    const row = await getMailRow(instance, ref, scopedMailFolders(scope))
    if (!row) {
      throw createError({
        statusCode: 404,
        message: 'No synced email has this id — it may have been deleted or moved since it was listed. List the folder again.',
      })
    }

    const body = await fetchMessageBody(instance, row)
    const text = body.text.slice(offset, offset + maxChars)
    const truncated = offset + maxChars < body.text.length

    return {
      ...presentEmail(row),
      ...(row.messageId && { messageId: row.messageId }),
      ...(row.inReplyTo && { inReplyTo: row.inReplyTo }),
      ...(row.references.length > 0 && { references: row.references }),
      body: text,
      bodyFormat: body.source === 'html' ? 'converted from HTML' : body.source === 'text' ? 'plain text' : 'none',
      bodyLength: body.text.length,
      ...(offset > 0 && { offset }),
      truncated,
      ...(truncated && { nextOffset: offset + maxChars }),
      ...(body.cutAtSource && {
        note: 'This email\'s body is larger than this connector fetches; the text ends early even after the last offset.',
      }),
      ...(body.source === 'none' && { note: 'This email has no text body; its content, if any, is in its attachments.' }),
    }
  },
})
