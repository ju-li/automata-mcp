import type { AppOrganization, AppUser } from '~~/server/utils/pocketbase'

/**
 * Preview an invitation, for the page behind the link.
 *
 * Reachable without a session — the whole point is that the recipient may not
 * have an account yet. Holding the code is the authorization: it is 32 random
 * bytes and resolves by hash, so this exposes nothing to anyone who does not
 * already have the link.
 *
 * What it exposes even then is deliberately thin: the organization's name and
 * the invited address, which the recipient needs in order to decide whether to
 * accept and which account to accept with. Never the member list.
 *
 * An unusable invitation says *why* — expired, revoked, already used. Whoever
 * holds the code already knows it existed, so distinguishing those from "never
 * existed" leaks nothing and saves a support round-trip.
 */
export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')
  const { invite, problem } = await resolveInvite(code ? decodeURIComponent(code) : '')

  if (problem || !invite) {
    return {
      ok: false as const,
      reason: problem ?? 'not-found',
      message: inviteProblemMessage(problem ?? 'not-found'),
    }
  }

  const pb = await pocketbaseAdmin()
  const org = await getOneOrNone<AppOrganization>(pb, 'organizations', invite.org)
  if (!org) {
    // The organization was deleted after the invitation was sent. Nothing to
    // join, and the invitation is the only thing that still points at it.
    return { ok: false as const, reason: 'not-found', message: inviteProblemMessage('not-found') }
  }

  // Whether the signed-in account (if any) can actually take this invitation —
  // so the page can say "you are signed in as someone else" rather than letting
  // them press a button that is going to fail.
  const user = event.context.user as AppUser | undefined
  const emailMatches = user ? normaliseEmail(user.email) === invite.email : undefined

  return {
    ok: true as const,
    org: { name: org.name },
    email: invite.email,
    role: invite.role,
    expires_at: invite.expires_at || undefined,
    signedInAs: user?.email,
    emailMatches,
  }
})
