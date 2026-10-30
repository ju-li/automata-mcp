import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import type { MailAddress, MailRow } from '~~/server/utils/imap-db'

const MAX_BODY_CHARS = 100_000
const MAX_RECIPIENTS = 50

/**
 * The one IMAP write tool: it saves an unsent draft in the mailbox's own
 * Drafts folder, and the owner sends it — or not — from their mail client.
 * Nothing here sends mail; this connection has no SMTP credentials at all.
 *
 * On the hints: `destructiveHint` is false for the reason `send-text-message`
 * gives — it adds a message and replaces none. `idempotentHint` is false:
 * two calls leave two drafts.
 *
 * The folder is never an argument (see `draftsFolder`), the body is plain text
 * only, and nothing from another email is copied in — a reply is threaded by
 * its headers, and quoting is the model's choice after `read-email`.
 */
export default defineKindTool({
  name: 'create-email-draft',
  kind: 'imap',
  title: 'Create email draft',
  description:
    'Save a plain-text email as an unsent draft in this mailbox\'s Drafts folder, for the owner to '
    + 'review and send from their own mail client. This does NOT send anything and cannot: tell the '
    + 'user the draft is waiting in Drafts. When the user did not dictate the text, show it to them '
    + 'before saving. To reply, pass the email\'s `emailId` (from list-emails, search-emails or '
    + 'read-email) as `replyToEmailId`: the draft is threaded under it, the subject defaults to '
    + '"Re: …" and the recipient to its sender. The original text is not quoted automatically — read '
    + 'it with read-email and include what is needed. `cc` and `bcc` are never filled in for you. '
    + 'The draft appears in list-emails after the next sync, within a few minutes.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    to: z.array(z.string().email()).max(MAX_RECIPIENTS).optional()
      .describe('Recipient addresses. Required unless replyToEmailId is given, which defaults it to the original sender'),
    cc: z.array(z.string().email()).max(MAX_RECIPIENTS).default([]).describe('Cc addresses'),
    bcc: z.array(z.string().email()).max(MAX_RECIPIENTS).default([]).describe('Bcc addresses'),
    subject: z.string().max(998).optional()
      .describe('Subject line. Defaults to "Re: <original subject>" when replying'),
    body: z.string().max(MAX_BODY_CHARS).describe('The message text, plain text only'),
    replyToEmailId: z.string().min(1).max(2000).optional()
      .describe('The emailId of the email this replies to, unchanged from list-emails, search-emails or read-email'),
  },
  handler: async ({ to, cc, bcc, subject, body, replyToEmailId }) => {
    const { instance, scope } = useMcpAuth()

    const from = instance.imap_user?.trim()
    if (!from || !z.string().email().safeParse(from).success) {
      throw createError({
        statusCode: 422,
        message: 'This mailbox logs in with a username that is not an email address, so a draft would have no '
          + 'sender. No draft was saved.',
      })
    }

    let original: MailRow | undefined
    if (replyToEmailId) {
      const ref = decodeEmailId(replyToEmailId)
      assertFolderAllowed(scope, ref.folderPath)
      original = await getMailRow(instance, ref, scopedMailFolders(scope))
      if (!original) {
        throw createError({
          statusCode: 404,
          message: 'No synced email has this id — it may have been deleted or moved since it was listed. '
            + 'List the folder again. No draft was saved.',
        })
      }
    }

    const recipients = to?.length ? to : original ? replyRecipients(original, from) : []
    if (!recipients.length) {
      throw createError({
        statusCode: 400,
        message: original
          ? 'The email being replied to names no address to reply to. Pass `to`. No draft was saved.'
          : 'A draft needs at least one address in `to`, or a `replyToEmailId`. No draft was saved.',
      })
    }

    // Resolved after the arguments are known to be usable, so a bad call is
    // refused for what is wrong with it rather than for the folder.
    const folder = await draftsFolder(instance, scope)

    const messageId = `<${randomUUID()}@${from.split('@').pop()}>`
    const raw = await composeDraft({
      from,
      to: recipients,
      cc,
      bcc,
      subject: (subject ?? (original ? replySubject(original.subject) : '')).replace(/[\r\n]+/g, ' ').trim(),
      text: body,
      messageId,
      ...threadHeaders(original),
    })

    const saved = await appendDraft(instance, folder.path, raw)

    // Best effort: the draft is saved whether or not this starts. When it does
    // not, the scheduled sync picks it up within minutes.
    let syncStarted = false
    try {
      syncStarted = await requestImapSync(instance)
    }
    catch (cause) {
      console.error(`[imap] could not start a sync after saving a draft for connection ${instance.id}`, cause)
    }

    return {
      saved: true,
      sent: false,
      folder: saved.folder,
      messageId,
      to: recipients,
      ...(cc.length > 0 && { cc }),
      ...(bcc.length > 0 && { bcc }),
      ...(original && { inReplyTo: original.messageId ?? null }),
      note: `Saved as an unsent draft in "${saved.folder}". Nothing was sent; the mailbox owner sends it from their `
        + `mail client. It appears in list-emails ${syncStarted ? 'once the sync that just started finishes' : 'after the next sync'}.`
        + (original && !original.messageId
          ? ' The original email has no Message-ID, so mail clients may not show this draft in its thread.'
          : ''),
    }
  },
})

/**
 * Who a reply goes to: the original sender — or, when the mailbox itself sent
 * the original, the people it was sent to, since replying to your own sent
 * mail means writing to them again. Reply-To is not synced, so it is not
 * honoured; the description says the default is the sender.
 */
function replyRecipients(original: MailRow, self: string): string[] {
  const own = self.toLowerCase()
  const addresses = (list: MailAddress[]) =>
    list.map(a => a.address?.trim()).filter((a): a is string => Boolean(a))
  const senders = addresses(original.from)
  if (senders.length && senders.every(a => a.toLowerCase() === own)) {
    return addresses(original.to).filter(a => a.toLowerCase() !== own)
  }
  return senders
}

/**
 * The headers that put a reply in its thread: the original's own id, and its
 * chain with that id last. Nothing without a Message-ID to point at.
 */
function threadHeaders(original: MailRow | undefined): { inReplyTo?: string, references?: string[] } {
  const id = original?.messageId
  if (!original || !id) return {}
  return { inReplyTo: id, references: [...original.references.filter(ref => ref !== id), id] }
}

function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`
}

interface DraftContent {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  messageId: string
  inReplyTo?: string
  references?: string[]
}

/**
 * RFC 822 bytes for a draft. Nodemailer's stream transport is a composer here,
 * not a sender: it writes the message into a buffer and goes nowhere. Used
 * rather than `MailComposer` directly because the stream transport keeps the
 * Bcc header — a draft that dropped it would lose those recipients when the
 * owner sends it.
 */
async function composeDraft(content: DraftContent): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
  const info = await composer.sendMail({
    from: content.from,
    to: content.to,
    ...(content.cc.length > 0 && { cc: content.cc }),
    ...(content.bcc.length > 0 && { bcc: content.bcc }),
    subject: content.subject,
    text: content.text,
    messageId: content.messageId,
    ...(content.inReplyTo && { inReplyTo: content.inReplyTo }),
    ...(content.references && { references: content.references }),
  })
  if (!Buffer.isBuffer(info.message)) {
    throw createError({ statusCode: 500, message: 'Could not build the draft.' })
  }
  return info.message
}
