/**
 * Say at boot how signups will be verified, when the answer is surprising.
 *
 * `required` with no SMTP refuses every signup and address change with a 503;
 * verification on with no `NUXT_PUBLIC_APP_URL` mails a code but no link. Both
 * are confusing to debug from the signup form, so they are announced here.
 */
export default defineNitroPlugin(() => {
  const setting = verificationSetting()
  const config = useRuntimeConfig()

  if (setting === 'required' && !config.smtpHost) {
    console.error(
      '[startup] NUXT_EMAIL_VERIFICATION=required but NUXT_SMTP_HOST is not set. '
      + 'Signups and email address changes will be refused until mail is configured.',
    )
    return
  }
  if (setting === 'auto' && !config.smtpHost) {
    console.warn(
      '[startup] Email verification is off because NUXT_SMTP_HOST is not set: anyone can sign up '
      + 'with an address they do not own. Configure SMTP, or set NUXT_EMAIL_VERIFICATION=off to silence this.',
    )
    return
  }
  if (emailVerificationRequired() && !config.public.appUrl) {
    console.warn('[startup] NUXT_PUBLIC_APP_URL is not set; verification emails will carry a code but no link.')
  }
})
