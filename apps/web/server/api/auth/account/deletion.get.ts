/**
 * What deleting your own account would take with it — the confirmation dialog
 * on the profile page names it before asking for the password. Changes
 * nothing; `account-deletion.ts` decides, and decides again at delete time.
 */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  return await previewAccountDeletion(user)
})
