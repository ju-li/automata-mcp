# Plans and billing

The hosted offering lets people sign up on their own and pick a plan first. This
page explains how to run that. **A self-hosted deployment does not need any of
it.** Leave `NUXT_CLOUD_URL` unset: there is then no plan picker, no Billing
page, no limits, and no account events.

The hosted offering is two services:

- **The web app** enforces limits and shows the Billing page. It never talks
  to Stripe.
- **The cloud service** (`apps/cloud`) sells plans. It owns Stripe (Checkout,
  the Customer Portal, the webhook, seat billing) and writes each
  organization's limits. Later it will also run the Brevo CRM sync and PostHog
  telemetry.

Self-hosted deployments never run the cloud service.

## The plans

| | Free | Pro |
|---|---|---|
| Price | $0 | 7-day trial, then $19/month |
| Connections | 1 | unlimited |
| Connector tokens | 1 | unlimited |
| Users | 1 | 5 included, $10/user/month after |
| Requests | unlimited | unlimited |

The numbers are set in two places:

- **Limits and plan rules:** `apps/cloud/src/plans.ts`.
- **Copy:** `apps/web/app/pages/signup.vue` and `billing.vue`.
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

## How limits are stored

The plan and its limits are kept apart:
- **Plan:** Stripe status, decided by the billing code.
- **Limits:** three plain numbers on each organization, `max_connections`, `max_tokens` and `max_members`. NULL means unlimited.

The cloud service writes those numbers whenever a subscription changes, and for every organization each time it starts. The web app's checks only ever read them, so they keep working, from the database, even while the cloud service is down.

A new organization gets the limits in `app.entitlement_defaults`, which the cloud service writes when it starts. Until that row exists, a hosted signup answers 503 rather than creating an organization with no limits. That only happens if the web app is deployed before the cloud service has ever run.

Unsetting `NUXT_CLOUD_URL` stops new limits from being written. It does **not** clear limits already written. A deployment that switches the hosted offering off after using it should clear them:

```sql
UPDATE app.organizations SET max_connections = NULL, max_tokens = NULL, max_members = NULL, plan_label = NULL;
```

## Account events

On the hosted deployment the web app also records account and organization changes in `app.hosted_events`. The cloud service reads them. Today it acts only on membership changes (to bill seats) and on deleted organizations (to cancel what they were paying for). The CRM sync (Brevo) and telemetry (PostHog) will read the same rows. The changes recorded:
- signups and email changes;
- organizations created and deleted;
- members joining, leaving and changing role;
- connections and tokens created and removed;
- plan changes;
- a per-minute count of MCP tool calls per organization.

Each consumer keeps its own position in `cloud.cursors`, and nothing deletes rows. A consumer added later therefore starts from the whole backlog.

Events never contain credentials, connection strings, chat or table names, message content or tool arguments. Email addresses appear only on user events. A self-hosted deployment writes none.

## Setting up Stripe

### 1. Create the product and prices

Create one product, "Automata Pro", with two recurring monthly prices:

- **Base:** $19.00, flat rate, licensed. Put its id in the cloud service's
  `STRIPE_PRICE_BASE`.
- **Seat:** $10.00 per unit, licensed (not metered). Put its id in
  `STRIPE_PRICE_SEAT`.

### 2. Add the webhook endpoint

Point it at the **cloud service**, `https://<cloud service>/webhooks/stripe`, with these events:

- `checkout.session.completed`
- `customer.subscription.created`, `.updated`, `.deleted`, `.paused`,
  `.resumed`, `.trial_will_end`

Put its signing secret in the cloud service's `STRIPE_WEBHOOK_SECRET`.

The cloud service writes nothing from the event itself. It looks up the
customer's organization and re-reads that customer's subscriptions from
Stripe. An hourly reconcile does the same for every billed organization, so a
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

### 6. Deploy the cloud service

On Railway, add a service from this repository:
- **Root directory:** the repo root.
- **Dockerfile path:** `apps/cloud/Dockerfile`.
- **Public domain:** give it one; Stripe needs to reach `/webhooks/stripe`.

Set its variables:

```bash
CLOUD_DATABASE_URL=postgres://…        # the same database as the web app's NUXT_DATABASE_URL
CLOUD_ADMIN_KEY=…                      # openssl rand -hex 32; the web app sends it on every call
APP_URL=https://mcp.getautomata.app    # the web app's public address: Checkout returns here
STRIPE_SECRET_KEY=rk_live_…            # the restricted key
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_BASE=price_…
STRIPE_PRICE_SEAT=price_…
```

The four `STRIPE_*` variables go together. With none set the service still runs and still writes limits, but starting Pro answers 503. With some but not all set, it refuses to start.

`GET /health` answers `{ ok, app, billing }`. `app` is `waiting` until the web app has run its migrations; the cloud service waits for them rather than failing.

**Database access.** The service connects to the web app's database. It reads `app` tables, writes only organizations' billing and limit columns and `app.hosted_events`, and keeps its own state in a `cloud` schema it creates. The simplest setup reuses the web app's database URL. To narrow it, give it a role with:
- `SELECT` on `app.organizations`, `app.memberships`, `app.hosted_events` and `app.migrations`;
- `UPDATE` on `app.organizations`;
- `INSERT` on `app.hosted_events` and `INSERT, UPDATE` on `app.entitlement_defaults`;
- `CREATE` on the database, or an existing `cloud` schema it owns.

It never needs `app.instances`, where connection credentials live.

### 7. Point the web app at it

On the web service:

```bash
NUXT_CLOUD_URL=http://<cloud service>.railway.internal:8080   # its private address
NUXT_CLOUD_ADMIN_KEY=…                              # the same value as CLOUD_ADMIN_KEY
NUXT_PUBLIC_APP_URL=https://mcp.getautomata.app
NUXT_SIGNUP=open
```

Railway injects `PORT=8080` into every service, and the cloud service follows it.

### Upgrading from the single-service setup

Before the cloud service existed, the web app talked to Stripe itself, configured with `NUXT_BILLING` and `NUXT_STRIPE_*`. To move over:

1. Deploy the cloud service (step 6). It writes `app.entitlement_defaults` and re-derives every organization's limits as soon as the web app's migration `0007_entitlement_defaults` has run.
2. On the web service, set `NUXT_CLOUD_URL` and `NUXT_CLOUD_ADMIN_KEY`, and remove `NUXT_BILLING` and the four `NUXT_STRIPE_*` variables.
3. In Stripe, change the webhook destination's URL from `https://<web app>/api/webhook/stripe` to `https://<cloud service>/webhooks/stripe`. The signing secret stays the same.

Deliveries Stripe sends to the old URL in the meantime fail and are retried. The hourly reconcile also catches up anything missed.

If the web app is upgraded with `NUXT_BILLING` still set and no `NUXT_CLOUD_URL`, plans stay enforced and the Billing page answers 503. The startup log says which variables to set; nothing becomes unlimited.

### Startup checks and failure behaviour

- Both services log anything missing at boot.
- **Limits are enforced from the database even when the cloud service is down or has no Stripe keys.** Starting Pro then answers 503, and the Billing page still shows the limits and usage.
- **New organizations need the defaults row.** A hosted signup is refused with 503 until the cloud service has started once.

## Testing locally

1. Start the cloud service with `pnpm cloud:dev`. It reads the same root `.env`, so set `CLOUD_*`, `APP_URL` and `STRIPE_*` there. Point the web app at it with `NUXT_CLOUD_URL=http://localhost:8096`.
2. Run `stripe listen --forward-to localhost:8096/webhooks/stripe` and use
   the `whsec_…` it prints.
3. Use test-mode keys and prices, and card `4242 4242 4242 4242`.
4. To see a trial end without waiting seven days, attach a Stripe test clock to
   the customer and advance it. Card `4000 0000 0000 0341` attaches fine and
   then fails its first charge.

## Things to keep in mind

- **An organization deleted by its last member leaving cancels its
  subscription.** When the only member of an organization accepts an
  invitation elsewhere, the old organization is deleted. The cloud service
  sees the `org.deleted` event and cancels any live subscription that
  organization's Stripe customer holds, immediately.
- **Two checkouts started in two tabs can create two subscriptions.** Stripe
  allows this. The app refuses a new Checkout once a live subscription exists,
  but cannot stop two that are already open. If it happens, cancel the extra
  one in the Stripe dashboard.
- **Each subscription is tied to one Stripe customer per organization.** It is
  created on first checkout and recorded in `app.organizations.stripe_customer_id`.
