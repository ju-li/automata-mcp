/**
 * The signed-in user's OAuth sign-ins ("connected apps"): which app, which
 * connections each covers, when last used. Own rows only. Web surface, cookie
 * authenticated — `isOAuthClientPath` does not cover `/api/oauth/sessions`.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  return { sessions: await listOwnSessions(user.id) }
})
