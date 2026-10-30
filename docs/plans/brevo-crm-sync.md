# Plan: Brevo CRM sync for hosted signups

Status: **proposed**. Hosted offering only. Nothing here reaches a self-hosted
deployment.

## Goal

When someone signs up on the hosted deployment, a contact for them appears in
Brevo within a minute. It carries enough context for onboarding and sales: who
they are, when they joined, which plan they chose, which organization they are
in and with what role, and which plan that organization is on now. Later
changes (email address, role, organization, plan) keep the contact current.

## What already exists

This was designed for when the hosted billing split was built
([ju-li/automata-mcp#75](https://github.com/ju-li/automata-mcp/pull/75) and
commit `e4aebe3`). Most of the plumbing is already there:

- **The outbox.** `app.hosted_events` is written in the same transaction as
  each account change. The `user.signed_up` and `user.email_changed` payloads
  carry the email address on purpose, because "the CRM keys contacts on it"
  (`apps/web/server/utils/hosted-events.ts`). Nothing is written on a
  self-hosted deployment.
- **Rows are retained for this consumer.** The billing consumer never deletes
  rows, and each consumer keeps its own cursor in `cloud.cursors`. A consumer
  added later "starts from the beginning of the retained backlog"
  (`apps/cloud/src/db.ts`).
- **The service it belongs in.** `apps/cloud/src/main.ts` and `docs/billing.md`
  both say the Brevo sync joins the cloud service, fed by the same outbox.
- **Ordering inside a signup.** Both signup paths (`signup.post.ts`, and
  `complete()` in `email-verification.ts`) write `user.signed_up` and then
  `org.created` + `member.joined`, or `member.joined` through
  `acceptInviteInto`, in one transaction. A batch that holds the signup
  therefore holds the membership too.

So the web app needs no changes. This is one new consumer in `apps/cloud`.

## Design

### Where the code goes

- **`apps/cloud/src/crm.ts`**: the only file that talks to Brevo, the way
  `billing.ts` is the only one that talks to Stripe. It uses plain `fetch`
  against `https://api.brevo.com/v3` with the `api-key` header. No SDK: we use
  three endpoints, and the official SDK is a large generated client.
- **`apps/cloud/src/outbox.ts`**: pull the cursor read and write out of the
  billing consumer into two helpers, `readCursor(sql, consumer, startAt)` and
  `advanceCursor(sql, consumer, id)`. Billing keeps `startAt: 'newest'`. The
  CRM consumer uses `'oldest'`. Billing's behaviour stays exactly as it is.
- **`apps/cloud/src/main.ts`**: a second interval next to the billing one, with
  the same 15-second period and its own `consuming` guard.

### Configuration (`config.ts`)

| Variable | Meaning |
|---|---|
| `BREVO_API_KEY` | Turns the sync on. Unset: no CRM consumer and no cursor row. |
| `BREVO_LIST_IDS` | Optional. Comma-separated numeric list ids to add new contacts to. A non-numeric entry refuses to start. |
| `BREVO_API_URL` | Optional. Defaults to `https://api.brevo.com/v3`. Exists so failure modes can be tested against a local stub. |

Same rule as Stripe: unset means off, and a malformed value refuses to start
rather than passing for "off". `/health` gains `crm: 'configured' |
'unconfigured'`.

**The cursor is created only when the key is set.** A deployment that runs the
cloud service for weeks before adding `BREVO_API_KEY` still syncs every signup
from the retained backlog on the day the key arrives. That is the reason rows
are kept.

### Event = which contact to refresh; live read = what to send

This follows the rule the Stripe webhook already uses ("payload = hint, live
read = fact"). The consumer does **not** build contacts from event payloads.
Each event only says which users are affected:

| Event | Users to refresh |
|---|---|
| `user.signed_up`, `user.email_changed` | `user_id` |
| `member.joined`, `member.removed`, `member.role_changed` | `user_id` |
| `plan.changed` | every current member of `org` |
| everything else (`connection.*`, `token.*`, `usage.rollup`, `org.*`) | none; the cursor moves past them |

For each pass, the consumer gathers the affected user ids into a set, which
merges the three events of one signup into a single call. It then reads
current state from the app schema in one query:

```sql
SELECT u.id, u.email, u.name, u.created,
       m.role, o.id AS org_id, o.name AS org_name, o.plan_label
FROM app.users u
LEFT JOIN app.memberships m ON m.user_id = u.id
LEFT JOIN app.organizations o ON o.id = m.org
WHERE u.id = ANY($1)
```

Why read current state instead of trusting the payload:

- **Replays and reordering are harmless.** Replaying an old
  `user.email_changed` sends today's address, not the one from the payload.
- **A pass that stopped halfway re-sends the current state.** It never sends an
  intermediate one.
- **The email in the payload becomes a fallback, not the source.** If the
  payload and the live row disagree, the live row wins.

There is one exception. The plan chosen at signup (`payload.plan`) and
`invited` are facts about the signup itself and are stored nowhere else
(`email_verifications.plan` is deleted on verify). They are read from the
`user.signed_up` payload and sent only when that event is in the batch.

A user id that no longer matches a row is skipped and logged. The app has no
account deletion today, so this should not happen.

### What goes to Brevo

The contact is keyed on the **user id** as Brevo's `ext_id`, not on the email
address. That way an email change updates the same contact instead of creating
a second one.

| Brevo field | Source | Type |
|---|---|---|
| `email` | `app.users.email` | identifier |
| `ext_id` | `app.users.id` | identifier |
| `FULL_NAME` | `app.users.name` | text |
| `SIGNUP_DATE` | `app.users.created` | date |
| `SIGNUP_PLAN` | `user.signed_up` payload (`free` / `pro` / empty when invited) | text |
| `INVITED` | `user.signed_up` payload | boolean |
| `ORG_ID`, `ORG_NAME` | the user's organization | text |
| `ORG_ROLE` | `admin` / `member` | text |
| `PLAN` | `organizations.plan_label` (`Free`, `Pro`, `Pro (trial)`) | text |

That is the whole list. The rule from `hosted-events.ts` extends to Brevo:
never send connection kinds or counts, hosts, chat, folder or table names,
token data, usage, or anything else from `instances`. Adding a field later is
a decision recorded in this file, not a one-line change.

The service never sends `emailBlacklisted`, `smsBlacklisted` or unsubscribe
state. Unsubscribes belong to Brevo, and a re-sync must not undo one.

### The upsert, per user

1. `PUT /contacts/{userId}?identifierType=ext_id` with `{ attributes: { EMAIL, …the rest } }`.
   This updates the existing contact, including its address.
2. If that returns **404**, run `POST /contacts` with
   `{ email, ext_id, attributes, listIds: BREVO_LIST_IDS }`. List membership is
   set **only on create**, so someone who left a list is never put back on it.
3. If the create returns a duplicate-email error, a contact for that address
   already exists without our `ext_id` (a newsletter signup, say, or an
   imported list). Claim it: `PUT /contacts/{email}?identifierType=email_id`
   with `ext_id` and the attributes.

Each step is idempotent, so processing an event twice costs one extra call and
changes nothing.

> Before building this, verify these Brevo behaviours against a free account:
> how `identifierType=ext_id` behaves, whether updating `EMAIL` through
> `attributes` re-keys the contact, the exact error code for a duplicate
> email, and whether an unknown attribute name is refused or silently dropped.
> They come from Brevo's API reference, not from a test.

### Attributes are ensured at boot

When the key is set, the service lists Brevo's contact attributes once at
startup and creates any that are missing
(`POST /contacts/attributes/normal/{name}`). Otherwise a typo, or an attribute
nobody created in the dashboard, would mean the data never arrives without
anyone noticing. If this fails, the CRM consumer stays off for that process
and the reason is logged. Billing is unaffected.

### Failures

Like the `org.deleted` cancellation, this has no reconcile behind it today. A
dropped event would mean a missing contact. So:

| Brevo answer | What the consumer does |
|---|---|
| network error, 5xx, **429** | Stop the cursor before this event and retry on the next pass. On 429, wait until Brevo's rate-limit reset header before the next pass. |
| **401 / 403** | Stop the cursor and log, at most once per minute, that the key is wrong. Skipping would throw away every later event. |
| any other 4xx (for example an address Brevo rejects as invalid) | Permanent for this event. Log it with the event id, user id, status and Brevo's `code` (never the address), record it in `cloud.crm_skipped`, and move on. |

`cloud.crm_skipped (event_id, user_id, status, code, at)` lets someone replay a
skipped event by hand once its cause is fixed. It is created by
`ensureCloudSchema` like `cursors`.

Logs never contain the email address, the name or the API key, and the error
helper never echoes request bodies.

### Replicas

The billing consumer already assumes one cloud replica. Duplicate passes would
be harmless here (every call is an idempotent upsert), but the cursor update
could go backwards. If the service ever runs more than one replica, both
consumers should take a lease on their `cloud.cursors` row with a conditional
`UPDATE`, the way IMAP sync does, rather than an advisory lock held across
HTTP calls. This is not part of this change.

## Rollout

1. **Before turning it on**, add Brevo as a sub-processor in the privacy policy
   at getautomata.app/privacy. It lives outside this repo. Signups already
   accepted it, so this is the gate.
2. Create a Brevo API key. Create the target list if you use one (see the
   consent question below).
3. Set `BREVO_API_KEY` (and `BREVO_LIST_IDS` if used) on the cloud service on
   Railway and redeploy.
4. On first boot, the service ensures the attributes, creates the `crm` cursor
   at the oldest retained event, and works through the backlog. It handles 500
   events per pass, so a backlog of a few thousand clears in minutes. Most
   events are `usage.rollup` and are skipped without any Brevo call.
5. Check: `/health` reports `crm: configured`, the log reports the number of
   contacts synced, and `cloud.crm_skipped` is empty.

## Testing

There is no test framework (see `CLAUDE.md`). `pnpm cloud:typecheck` must pass.
Then test by hand:

- **Real Brevo (free account):** sign up without an invitation, sign up through
  an invitation, verify by link, change email address, change role, move
  organization, and make a Stripe-test plan change. Each change should appear
  on one contact, and an email change should not create a second contact.
- **Local stub** via `BREVO_API_URL`, answering 500, 429 with a reset header,
  401, and a 400 for an invalid email. Check that the cursor stops on the first
  three and moves on after the fourth, with a row in `cloud.crm_skipped`.
- **Key unset:** no cursor row, no Brevo traffic, `/health` reports
  `crm: unconfigured`, billing unchanged.
- **Key added later:** the backlog from before the key was set is synced.
- **Self-hosted:** unchanged by construction (no events are written, and the
  cloud service is not deployed). Confirm `pnpm typecheck` still passes,
  because nothing in `apps/web` should change.

## Docs to update with the change

- `docs/billing.md`: retitle "Account events" or add a "CRM (Brevo)" section
  covering the variables, the attribute list, what is never sent, failure
  handling, and replaying `cloud.crm_skipped`.
- `CLAUDE.md`, "Plans and billing": one bullet for the CRM consumer (starts at
  the oldest event, contact keyed on `ext_id`, live read, fixed attribute
  list, failure table). Change "Brevo CRM sync … join it later" to present
  tense.
- `apps/cloud/src/main.ts` and `outbox.ts` header comments.

## Later (not in this change)

- **Organizations as Brevo companies:** `org.created` → `POST /companies`,
  members linked through `link-unlink`, `org.deleted` → delete. Worth doing
  once sales works per account rather than per person.
- **Activation signals:** a "first connection created" date, or a "last MCP
  use" date from `usage.rollup`. These would need a decision against the
  payload rules above, so they are left out on purpose.
- **A nightly full reconcile** that re-upserts every user, as a backstop like
  the hourly Stripe one. Only worth it if `cloud.crm_skipped` or drift shows
  it is needed.

## Open questions

1. **Consent and lists.** Is a signup a marketing contact, or only a CRM
   record? The signup form has no marketing opt-in today. The default proposed
   here is to create the contact and add it to a "Product users" list used for
   onboarding and product email only, with no newsletter list. Adding a
   newsletter would need an opt-in checkbox on signup, a new
   `user.signed_up` payload field, and a `MARKETING_OPT_IN` attribute.
2. **Users from before the outbox.** Accounts created before `e4aebe3` have no
   `user.signed_up` event. Options: a one-off `pnpm cloud:crm-backfill` that
   upserts every `app.users` row, or nothing if there are only a handful.
   Recommendation: the backfill script, since it reuses the same upsert.
3. **Name fields.** The proposal sends the whole name as `FULL_NAME` rather
   than guessing a `FIRSTNAME`/`LASTNAME` split. Splitting on the first space
   is wrong for many names. If Brevo templates need `{{ contact.FIRSTNAME }}`,
   we could send the first word there as well, as a greeting only.
