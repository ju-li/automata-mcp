/**
 * Outbound email, through PocketBase's mailer.
 *
 * PocketBase exposes no generic send-email endpoint — every mail route it ships
 * is auth-flow bound — so `services/pocketbase/pb_hooks/mail.pb.js` registers
 * one, superuser-only, and this is its only caller. Sending through PocketBase
 * rather than an SMTP client here is what keeps the deployment to a single mail
 * configuration: the same settings send the alerts and any auth mail added
 * later, and there is no second set of credentials to keep in step.
 *
 * The admin client authenticates as the superuser already, for the hidden
 * fields; `pb.send()` attaches that token.
 */

export interface AppEmail {
  to: string
  subject: string
  text?: string
  html?: string
}

/**
 * Send one email. Answers whether it went out; never throws.
 *
 * A caller here is a background sweep or a webhook ack, and neither has anyone
 * to report a failure to — so a mail outage must not become a failed sweep that
 * skips the connections after it, or a non-2xx that sends Evolution into its
 * retry ladder. The cause is logged instead, because a handled error produces
 * nothing in Nitro's own logs and this is precisely the failure an operator
 * would otherwise have to guess at: unset SMTP settings answer 400 here and
 * look, from the outside, exactly like nothing having gone wrong.
 */
export async function sendAppEmail(mail: AppEmail): Promise<boolean> {
  if (!mail.to) return false

  try {
    const pb = await pocketbaseAdmin()
    await pb.send('/api/app/send-email', {
      method: 'POST',
      body: {
        to: mail.to,
        subject: mail.subject,
        text: mail.text ?? '',
        html: mail.html ?? '',
      },
    })
    return true
  }
  catch (error) {
    // The recipient is logged, the body is not: an alert mail names a
    // connection and links to it, and there is no reason to copy that into the
    // log to say that sending failed.
    console.error(
      `[mailer] could not send "${mail.subject}" to ${mail.to}. `
      + 'Check the PocketBase SMTP settings (PB_SMTP_HOST and friends) and that '
      + 'pb_hooks/mail.pb.js is loaded:',
      error,
    )
    return false
  }
}
