/** Mail a fresh code and link for this browser's pending verification. */
export default defineEventHandler(async (event) => {
  return await resendVerification(event)
})
