/// <reference path="../pb_data/types.d.ts" />

// PocketBase is this deployment's mailer.
//
// It has no generic send-email REST endpoint — every mail route it exposes is
// auth-flow bound (verification, password reset, email change, OTP) and sends a
// fixed template to the record's own address. Sending anything else is a JSVM
// job, so the Nuxt server reaches the mailer through the route registered here
// rather than carrying an SMTP client of its own. One SMTP configuration, in
// one place, used by both the auth mails and the connection alerts.
//
// Two halves:
//
//   onBootstrap  apply SMTP settings from the environment, so a deployment is
//                configured by variables like everything else here and not by
//                remembering to click through the admin UI.
//   routerAdd    POST /api/app/send-email, superuser only.
//
// Consumer: apps/web/server/utils/mailer.ts.

// ---------------------------------------------------------------------------
// SMTP from the environment
// ---------------------------------------------------------------------------
//
// Mirrors what entrypoint.sh does for the superuser: read the variables, apply
// them on every boot so a change is a redeploy rather than a manual step, and
// on failure warn and keep serving. A throw here would crash-loop the container
// and take away the admin UI — the one place this could be fixed by hand.
//
// With PB_SMTP_HOST unset this does nothing at all and leaves whatever the
// admin UI holds, so an operator who prefers to configure mail by hand can.
//
// NB the password is written into pb_data unless PB_ENCRYPTION_KEY is set —
// same standing as the `hidden` fields on `instances`. Hidden is an API
// projection, not encryption.
onBootstrap((e) => {
  e.next()

  const host = $os.getenv('PB_SMTP_HOST')
  if (!host) {
    console.log('[mail] PB_SMTP_HOST is not set; leaving the mail settings as they are.')
    return
  }

  try {
    const settings = $app.settings()

    settings.smtp.enabled = true
    settings.smtp.host = host
    settings.smtp.port = parseInt($os.getenv('PB_SMTP_PORT') || '587', 10)
    settings.smtp.username = $os.getenv('PB_SMTP_USERNAME')
    settings.smtp.password = $os.getenv('PB_SMTP_PASSWORD')
    // PLAIN unless asked otherwise; PocketBase accepts PLAIN or LOGIN.
    settings.smtp.authMethod = $os.getenv('PB_SMTP_AUTH_METHOD') || 'PLAIN'
    // false sends STARTTLS and lets the server decide, which is what a 587
    // submission port wants. Set PB_SMTP_TLS=true for implicit TLS on 465.
    settings.smtp.tls = $os.getenv('PB_SMTP_TLS') === 'true'

    const senderAddress = $os.getenv('PB_SENDER_ADDRESS')
    const senderName = $os.getenv('PB_SENDER_NAME')
    if (senderAddress) settings.meta.senderAddress = senderAddress
    if (senderName) settings.meta.senderName = senderName

    $app.save(settings)

    console.log('[mail] SMTP configured from the environment: ' + host + ':' + settings.smtp.port)
  }
  catch (err) {
    // Warn rather than exit. Mail stops working; nothing else does.
    console.log('[mail] WARNING: could not apply the SMTP settings: ' + err)
    console.log('[mail] Connection alerts will not be delivered until this is fixed.')
  }
})

// ---------------------------------------------------------------------------
// POST /api/app/send-email
// ---------------------------------------------------------------------------
//
// Superuser only. The guard is not decoration: this route sends mail from this
// deployment's address to any address given, so an unauthenticated version of
// it is an open relay wearing our domain. The only caller is the Nuxt server,
// which already authenticates as the superuser to read hidden fields.
//
// Body: { to, subject, text?, html? } — at least one of text/html.
routerAdd('POST', '/api/app/send-email', (e) => {
  const data = new DynamicModel({
    to: '',
    subject: '',
    text: '',
    html: '',
  })
  e.bindBody(data)

  const to = (data.to || '').trim()
  const subject = (data.subject || '').trim()

  if (!to) throw new BadRequestError('"to" is required')
  if (!subject) throw new BadRequestError('"subject" is required')
  if (!data.text && !data.html) throw new BadRequestError('one of "text" or "html" is required')

  const settings = $app.settings()

  const message = new MailerMessage({
    from: {
      address: settings.meta.senderAddress,
      name: settings.meta.senderName,
    },
    to: [{ address: to }],
    subject: subject,
    text: data.text || '',
    html: data.html || '',
  })

  $app.newMailClient().send(message)

  return e.json(200, { sent: true })
}, $apis.requireSuperuserAuth())
