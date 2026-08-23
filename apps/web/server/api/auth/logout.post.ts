export default defineEventHandler((event) => {
  clearSessionCookie(event)
  return { ok: true }
})
