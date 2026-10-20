/**
 * Start a sync now rather than at the next two-minute tick. Answers at once;
 * the dashboard keeps polling for the outcome.
 *
 * Manage-only, like reconnecting a WhatsApp account: it is what an owner does
 * after fixing a password, and it is also a login to someone's mailbox on
 * demand, which a member pressing it repeatedly should not be able to drive.
 * Also clears a stop left by a refused password, so "I fixed it on the
 * provider's side" has a button.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'imap')

  const started = await requestImapSync(instance)
  return { started }
})
