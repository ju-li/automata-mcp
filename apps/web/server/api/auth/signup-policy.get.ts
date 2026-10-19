/**
 * Whether the signup page should show its form, ask for a signup code, or send
 * people to an invitation. Public: it says how to sign up, never the code.
 */
export default defineEventHandler(async () => {
  return { selfSignup: await selfSignupPolicy() }
})
