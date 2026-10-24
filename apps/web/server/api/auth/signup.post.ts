import { z } from 'zod'

const body = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  name: z.string().max(100).optional(),
  /** Signing up through an invitation link joins that organization instead. */
  invite: z.string().max(200).optional(),
  /** `NUXT_SIGNUP_CODE`, when the deployment is invite-only and has one. */
  signupCode: z.string().max(200).optional(),
  /**
   * The plan picked on the signup page, with billing on. Required then for a
   * signup that creates an organization; ignored for an invited one, which
   * joins an organization that already has a plan, and without billing.
   */
  plan: z.enum(['free', 'pro']).optional(),
})

/**
 * Sign up, and land in an organization.
 *
 * The account and its organization (or its place in the inviting one) are
 * written in **one transaction**, which is what makes "every user has a
 * membership" an invariant rather than a hope: there is no window, and no
 * compensating delete, in which an account exists with nowhere to go. There is
 * deliberately no lazy self-heal elsewhere — creating an organization for
 * whoever turns up without one would hand a free one to anyone, and silently
 * resurrect a user an admin had just removed.
 *
 * Signing up **through an invitation** joins that organization instead, and
 * creates no solo organization. The invitation is resolved and its email checked
 * BEFORE anything is written, so a bad code costs nothing.
 *
 * Without an invitation, `NUXT_SIGNUP` decides (`server/utils/signup-policy.ts`):
 * open, a signup code, or — invite-only with no code — the first account only,
 * claimed inside the transaction so two racing first signups cannot both win.
 *
 * **With email verification on** (`server/utils/email-verification.ts`) every
 * check above still runs here, but nothing is written to `app.users`: the
 * signup waits, holding no claim on the address, until the mailed code or link
 * proves it, and the same transaction runs then. The answer does not say
 * whether the address already had an account — that mail says so instead.
 */
export default defineEventHandler(async (event) => {
  const { email, password, name, invite: code, signupCode, plan } = await parseBody(event, body)

  const invited = code ? await resolveInvite(code) : undefined
  const { firstAccountOnly } = invited ? { firstAccountOnly: false } : checkSelfSignup(event, signupCode)
  if (invited) {
    if (invited.problem || !invited.invite) {
      throw createError({
        statusCode: invited.problem === 'not-found' || !invited.problem ? 404 : 422,
        statusMessage: inviteProblemMessage(invited.problem ?? 'not-found'),
      })
    }
    if (normaliseEmail(email) !== invited.invite.email) {
      throw createError({
        statusCode: 403,
        statusMessage: `This invitation is for ${invited.invite.email}. Sign up with that address to accept it.`,
      })
    }
  }

  // The organization is created on Free whatever was picked; Pro begins when
  // Stripe confirms the trial. Picking Pro only decides where the browser goes
  // next: on to Checkout.
  const chosenPlan = !invited && billingEnabled() ? plan : undefined
  if (!invited && billingEnabled() && !chosenPlan) {
    throw createError({ statusCode: 422, statusMessage: 'Choose a plan to sign up.' })
  }
  const nextStep = chosenPlan === 'pro' ? 'checkout' as const : undefined

  const verify = emailVerificationRequired()
  if (verify && verificationSetting() === 'required') assertVerificationDeliverable()

  const passwordHash = await hashPassword(password)

  if (verify) {
    const pending = await startVerification(event, {
      purpose: 'signup',
      email,
      passwordHash,
      name: name?.trim() || email.split('@')[0] || '',
      inviteId: invited?.invite?.id,
      firstAccountOnly,
      plan: chosenPlan,
    })
    return { verificationRequired: true, email: pending.email }
  }

  const sql = await appDb()

  const user = await sql.begin(async (tx) => {
    if (firstAccountOnly) await claimFirstAccount(tx)
    const created = await createUser(tx, {
      email,
      passwordHash,
      name: name?.trim() || email.split('@')[0] || '',
    })
    await recordHostedEvent(tx, {
      type: 'user.signed_up',
      userId: created.id,
      payload: { email: created.email, name: created.name, plan: chosenPlan ?? null, invited: Boolean(invited?.invite) },
    })

    if (invited?.invite) {
      await acceptInviteInto(tx, created, invited.invite.org, invited.invite.role)
      await markInviteAccepted(tx, invited.invite.id, created.id)
    }
    else {
      await createOrganizationFor(tx, created)
    }
    return created
  })

  if (invited?.invite) syncSeatsLater(invited.invite.org)

  await startSession(event, user.id)
  return { id: user.id, email: user.email, next: nextStep }
})
