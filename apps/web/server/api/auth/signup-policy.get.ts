/**
 * Whether the signup page should show its form, ask for a signup code, or send
 * people to an invitation. Public: it says how to sign up, never the code.
 * `verification` tells the page a code will be mailed before the account exists.
 * `billing` tells it to ask for a plan first — only ever true on the hosted
 * offering; a self-hosted deployment never shows a plan picker.
 */
export default defineEventHandler(async () => {
  return {
    selfSignup: await selfSignupPolicy(),
    verification: emailVerificationRequired(),
    billing: billingEnabled(),
  }
})
