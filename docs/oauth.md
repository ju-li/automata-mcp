# Sign-in from Claude (OAuth)

Besides tokens in the URL, Claude can **sign in**:

1. Add the app's plain `https://<your-app>/mcp` address in Claude.
2. Claude opens this app. Sign in, tick the connections you want it to have,
   and approve.
3. Claude gets credentials of its own.

There is nothing to copy and nothing that can leak from a chat log or a
screenshot. **One sign-in can cover several connections**, so one connector in
Claude can reach your WhatsApp number, your database and your mailbox together.

Static tokens keep working exactly as before. Use them for clients that can't
sign in: Cursor's `mcp.json`, gateways that forward a header, scripts.

## Turning it on

OAuth is on whenever `NUXT_PUBLIC_APP_URL` is set to the address people open
the app at, and Claude must be able to reach that address. Every OAuth URL
(issuer, endpoints, the resource) is built from that one variable and never
from a request's `Host` header, so it has to be right.

| Variable | Meaning |
| --- | --- |
| `NUXT_PUBLIC_APP_URL` | Required. Unset means OAuth is off: discovery answers 404, and the MCP 401 points nowhere. |
| `NUXT_PUBLIC_OAUTH=off` | Turns OAuth off even with the URL set. |
| `NUXT_OAUTH_REDIRECT_HOSTS` | Optional, comma-separated, e.g. `claude.ai,claude.com`. When set, a client may register redirects only to these hosts (subdomains included) or to loopback. Empty allows any `https` host. |

## What a sign-in covers

**Connections.** On the consent page:

- Users tick connections from the ones they reach. For an admin that is every
  connection in the organization; for a member, the ones assigned to them.
- "All current connections" ticks them all as a **snapshot**. A connection
  added later is not included automatically. To add it, use **Add this
  connection to** on its Sign in from Claude card, which adds it to an existing
  sign-in without the app re-authorizing (it sees the new tools when it next
  lists them). Signing in again from the same app also works, and replaces the
  earlier sign-in.

**What each connection may do.** Each ticked connection starts at the same
default a new token gets: everything for WhatsApp and Telegram, read-only for a
database or mailbox.

- **Customize** narrows it.
- An **admin** can grant anything, with the same editor as the token dialog.
- A **member** can grant at most what the connection's **sign-in policy**
  allows, and can only untick actions within it.

**Sign-in policy (admins).** Each connection's page has a **Sign in from
Claude** card. Under **Members…** an admin chooses:

- whether members may sign the connection in at all (off by default)
- the most they may grant
- a disclaimer for messaging connections

The policy applies on every request, so narrowing it or switching it off takes
effect immediately for sign-ins members already made.

**Tool names.** Every tool in a sign-in is prefixed with its connection's
**handle**, e.g. `orders_db__run-query` or `us_number__send-text-message`.

- One sign-in can hold two connections of the same kind, and each tool still
  reaches exactly one connection.
- The handle is generated from the connection's name, is unique in the
  organization, and can be changed on the card. Renaming it renames the tools in
  every signed-in app, which resets any per-tool permissions set there.
- Static tokens keep un-prefixed tool names.

## Connected apps

**Profile → Connected apps** lists each app signed in to your account, the
connections it covers with their access, and when it was last used. **Sign out**
there ends that sign-in on every connection. Apps that registered with a
metadata document show their verified domain.

## How apps register

- **Client ID Metadata Documents (preferred)**, the method the MCP spec
  recommends since 2026-07-28. Claude uses it when the server advertises
  `client_id_metadata_document_supported`.
  - The app's `client_id` is an `https` URL. This server fetches the JSON
    document there, checks it, and caches it for an hour; a failed refresh
    keeps a copy younger than a day.
  - The consent page then shows the app's **domain as verified**, rather than
    only the name the app chose.
  - The fetch is guarded like any user-supplied host: private addresses are
    refused unless `NUXT_ALLOW_PRIVATE_TARGETS` is set, and this deployment's
    own services always are.
  - The socket dials the address the guard approved. No redirects are
    followed, there is a 5-second timeout and a 10 KB limit, and only JSON is
    accepted.
  - The document must name its own URL as `client_id`, carry no secret, use
    `token_endpoint_auth_method: none`, and list the redirect URI being used.
  - `NUXT_OAUTH_REDIRECT_HOSTS` applies to its redirects too.
- **Dynamic Client Registration (deprecated, still accepted)** at
  `/api/oauth/register`, for apps that have not moved yet.

**Scopes.** There is one scope, `mcp`. It is advertised in both metadata
documents, named in the 401 challenge, and returned with every token. What a
sign-in can reach is decided per connection on the consent page, which is finer
than a scope can express.

## Lifetime and revocation

Behind the scenes, a sign-in is a session holding the credentials, plus one
connector row per connection it covers. Each row has its own scope.
Everything that ends a token ends that one connection, the same as before:
Revoke on the dashboard, unassigning the connection, removing the member, or
demoting an admin. A sign-in that loses every connection asks the user to sign
in again.

| What happens | Effect |
| --- | --- |
| **Revoke** on a connection's token list | That connection leaves the sign-in. Its other connections keep working. |
| **Sign out** on a connection's token list | The whole sign-in ends, every connection it covered. |
| Signing in again from the same app | Replaces the earlier sign-in. |
| A refresh token used twice (someone else has a copy) | The sign-in ends. A repeat within 30 seconds counts as the client racing itself: that request is refused and nothing ends. |
| No refresh for 30 days | The sign-in ends; the user signs in again. |
| "Disconnect" in the client (RFC 7009 revocation) | The sign-in ends. |

Access tokens last an hour, and refresh tokens rotate on every use.

**Plan limits** count each connection in a sign-in as one connector token.
- The consent page refuses a sign-in that would exceed the limit, and says why.
- Over its limits, a sign-in keeps the connections still within them.

## Endpoints

| Path | What |
| --- | --- |
| `/.well-known/oauth-protected-resource`, `…/mcp` | RFC 9728 resource metadata. The MCP 401's `resource_metadata` points at the `/mcp` form. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `/api/oauth/register` | RFC 7591 dynamic client registration — deprecated in MCP in favour of metadata documents, kept for older apps. Public clients only (`token_endpoint_auth_method: none`), throttled per address. Echoes `application_type`. |
| `/oauth/authorize` | The consent page. Refuses to render in a frame. |
| `/api/oauth/token` | `authorization_code` with PKCE `S256` (required), and `refresh_token`. |
| `/api/oauth/revoke` | RFC 7009. |

**Registration is open by design**, both kinds, because that is what lets Claude
add the connector with no setup.

- A registered client can do nothing until a signed-in person approves it.
- The consent page shows the client's name as the client's own claim.
- It also shows the host it will send the browser back to, which is the part
  that can be verified.
- `NUXT_OAUTH_REDIRECT_HOSTS` narrows registration further if you want that.

**OAuth access tokens are accepted only in the `Authorization` header**, never
in the `/mcp/<token>` path. That path form is for static tokens, and its 401
carries no metadata pointer.

## Operational notes

- **A database outage answers 503, never `invalid_grant`.** `invalid_grant` would
  tell Claude to throw its refresh token away and sign every connector out. The
  same rule keeps a 401 off the MCP endpoint during an outage.
- **Codes, access and refresh tokens are stored only as SHA-256 hashes**, like
  static tokens.
- **Codes and sessions live in the database, not in memory**, so several
  replicas can serve one flow.
- **Connections are created at code exchange, not approval**, so a consent the
  client never completes leaves nothing behind.
- **Changing the domain** in `NUXT_PUBLIC_APP_URL` changes the issuer and the
  resource, and every OAuth client has to connect again. Static tokens are
  unaffected.
