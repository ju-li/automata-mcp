# Plans and billing

The hosted offering lets people sign up on their own and pick a plan first. This
page explains how to run that. **A self-hosted deployment does not need any of
it.** Leave `NUXT_BILLING` unset: there is then no plan picker, no Billing page,
and no limits.

## The plans

| | Free | Pro |
|---|---|---|
| Price | $0 | 7-day trial, then $19/month |
| Connections | 1 | unlimited |
| Connector tokens | 1 | unlimited |
| Users | 1 | 5 included, $10/user/month after |
| Requests | unlimited | unlimited |

The numbers are set in two places:

- **Limits and copy:** `server/utils/billing.ts` and `app/pages/signup.vue`.
- **Prices:** the two Stripe prices below.

Change both together.

## How it behaves

### Signing up and starting the trial

- The signup page asks for a plan first. A link with `?plan=free` or
  `?plan=pro` skips that step, so a marketing site can link straight to the
  plan.
- **Every new organization starts on Free.** Choosing Pro sends the browser on
  to Stripe Checkout after signup (after email verification, when that is on).
  The organization becomes Pro only when Stripe confirms the subscription.
- If someone abandons Checkout, they have a working Free account and can start
  the trial later from the Billing page.
- The trial needs a card. Stripe charges $19 on day 8 unless the trial is
  cancelled first.
- Each organization gets one trial. An organization that has ever held a
  subscription is offered a plain upgrade with no trial.

### Seats

Members beyond the included five are billed seats, charged with proration. The
app updates the seat price's quantity on its own whenever someone joins or is
removed. Pending invitations are not billed.

### When a subscription lapses

A trial that ends unpaid, a card that fails for good, or a cancellation puts
the organization back on Free. **Nothing is deleted.** While it holds more than
Free allows:

- It cannot add connections, tokens or members. The server answers 402
  `plan_limit`, and the UI offers the Billing page.
- Exactly one connector token keeps working: the oldest live token on the
  oldest connection.
- Every other token answers **403**, never 401, so the MCP client keeps it.
  Resubscribing brings every token back with nothing to reconfigure.
- Everyone in the organization sees a banner about it.

`past_due` counts as Pro while Stripe is still retrying the charge. Your
retry settings in Stripe decide how long that lasts.

## Setting up Stripe

### 1. Create the product and prices

Create one product, "Automata Pro", with two recurring monthly prices:

- **Base:** $19.00, flat rate, licensed. Put its id in `NUXT_STRIPE_PRICE_BASE`.
- **Seat:** $10.00 per unit, licensed (not metered). Put its id in
  `NUXT_STRIPE_PRICE_SEAT`.

### 2. Add the webhook endpoint

Point it at `https://<your app>/api/webhook/stripe`, with these events:

- `checkout.session.completed`
- `customer.subscription.created`, `.updated`, `.deleted`, `.paused`,
  `.resumed`, `.trial_will_end`

Put its signing secret in `NUXT_STRIPE_WEBHOOK_SECRET`.

The app writes nothing from the event itself. It looks up the customer's
organization and re-reads that customer's subscriptions from Stripe. An hourly
task (`billing:reconcile`) does the same for every billed organization, so a
lost delivery corrects itself within the hour.

### 3. Configure the Customer Portal

Under **Settings → Billing → Customer portal**:

- **Allow:** updating the payment method, viewing invoices, and cancelling
  subscriptions.
- **Do not allow:** changing quantities or switching plans. Seats follow
  membership, and the app resets any quantity edited by hand.

### 4. Turn on Stripe's own emails

Under **Settings → Billing → Subscriptions and emails**, enable:

- the trial-ending reminder;
- failed-payment emails;
- the retry schedule (smart retries).

The app sends none of these itself.

### 5. Promotion codes (optional)

Checkout shows an "Add promotion code" field. To comp an account or run a
promo, create a coupon under **Product catalog → Coupons** (for example 100% off,
forever), then add a customer-facing **promotion code** to it — the code is what
people type, the coupon on its own has none. A code applied at Checkout stays on
the subscription, so a 100%-off-forever code keeps invoices at $0 while the
organization reads as Pro.

### 6. Set the environment

```bash
NUXT_BILLING=stripe
NUXT_STRIPE_SECRET_KEY=sk_live_…
NUXT_STRIPE_WEBHOOK_SECRET=whsec_…
NUXT_STRIPE_PRICE_BASE=price_…
NUXT_STRIPE_PRICE_SEAT=price_…
NUXT_PUBLIC_APP_URL=https://app.example.com   # required: Checkout returns here
NUXT_SIGNUP=open
```

### Startup checks and failure behaviour

- At boot, the app logs anything that is missing.
- **Limits are enforced even when Stripe is not configured.** Starting Pro then
  answers 503.
- Any unknown value of `NUXT_BILLING` is treated as `stripe`, so a typo cannot
  give every organization unlimited use.

## Testing locally

1. Run `stripe listen --forward-to localhost:3000/api/webhook/stripe` and use
   the `whsec_…` it prints.
2. Use test-mode keys and prices, and card `4242 4242 4242 4242`.
3. To see a trial end without waiting seven days, attach a Stripe test clock to
   the customer and advance it. Card `4000 0000 0000 0341` attaches fine and
   then fails its first charge.

## Things to keep in mind

- **Leaving an organization with an active subscription is refused.** A sole
  admin who accepts an invitation elsewhere would otherwise have their old
  organization deleted while it is still billing. They need to cancel first;
  a subscription set to cancel at the period end is accepted.
- **Two checkouts started in two tabs can create two subscriptions.** Stripe
  allows this. The app refuses a new Checkout once a live subscription exists,
  but cannot stop two that are already open. If it happens, cancel the extra
  one in the Stripe dashboard.
- **Each subscription is tied to one Stripe customer per organization.** It is
  created on first checkout and recorded in `app.organizations.stripe_customer_id`.
