# Sign-in from Claude (OAuth)

Besides tokens in the URL, a connector can **sign in**: you add the app's plain
`https://<your-app>/mcp` address in Claude, Claude opens this app, you sign in
and approve, and Claude gets tokens of its own. There is nothing to copy and
nothing that can leak from a chat log or a screenshot.

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

## How it works

**An admin decides, the holder claims.** On a connection's dashboard an admin
creates a **New token** and picks **Sign in from Claude**. This makes a
connector with a name, an expiry, a scope and a holder, like any token, but
with no secret. It reads **Awaiting sign-in** and authenticates nothing.

The holder then adds `https://<your-app>/mcp` in Claude (Settings →
Connectors → Add custom connector, leaving the advanced OAuth fields empty) or
runs `claude mcp add --transport http <name> https://<your-app>/mcp` in Claude
Code. Claude opens this app, the holder signs in (with their second factor, if
they have one) and picks the connector.

- **The consent page lists only your own connectors.** They must be issued to
  you, alive, and on a connection you still reach. Nothing on it changes
  scope, so a member can't widen anything by approving.
- **An admin with nothing waiting** can create a connector for themselves right
  on the consent page. It uses the same default access a new token gets
  (read-only for a database or mailbox), expires in 90 days, and can be edited
  on the connection's page afterwards.
- **A member with nothing waiting** is told which admins to ask.

What the client gets is short-lived: an access token for an hour and a refresh
token that rotates on every use.

| What happens | Effect |
| --- | --- |
| **Revoke** on the dashboard, removing the member, unassigning the connection, demoting an admin | Kills the connector, the same as a static token. |
| **Sign out** on the dashboard | That client stops working. The connector stays, and its holder can sign in again from any client. This is the OAuth form of "issue a new secret". |
| Signing in again from another client | Moves the connector there. The previous client is signed out. |
| A refresh token used twice (someone else has a copy) | The connector is signed out until its holder signs in again. A repeat within 30 seconds counts as the client racing itself: that request is refused and nothing is signed out. |
| "Disconnect" in the client (RFC 7009 revocation) | Same as **Sign out**. |

**Plan limits** count a connector from the moment it is created. A connector
nobody has signed in to yet never takes a working token's place when an
organization is over its limits.

## Endpoints

| Path | What |
| --- | --- |
| `/.well-known/oauth-protected-resource`, `…/mcp` | RFC 9728 resource metadata. The MCP 401's `resource_metadata` points at the `/mcp` form. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `/api/oauth/register` | RFC 7591 dynamic client registration. Public clients only (`token_endpoint_auth_method: none`), throttled per address. |
| `/oauth/authorize` | The consent page. Refuses to render in a frame. |
| `/api/oauth/token` | `authorization_code` with PKCE `S256` (required), and `refresh_token`. |
| `/api/oauth/revoke` | RFC 7009. |

Registration is open by design, because that is what lets Claude add the
connector with no setup. A registered client can do nothing until a signed-in
person approves it. The consent page shows the client's name as the client's
own claim and shows the host it will send the browser back to, which is the
part that can be verified. `NUXT_OAUTH_REDIRECT_HOSTS` narrows registration
further if you want that.

A path-token URL (`/mcp/wamcp_…`) never starts OAuth: its 401 carries no
metadata pointer, because a dead path token needs a new token, not a sign-in.

## Operational notes

- **A database outage answers 503, never `invalid_grant`.** `invalid_grant` would
  tell Claude to throw its refresh token away and sign every connector out. The
  same rule keeps a 401 off the MCP endpoint during an outage.
- **Codes, access and refresh tokens are stored only as SHA-256 hashes**, like
  static tokens. They only ever travel in request bodies and the
  `Authorization` header.
- **Codes and grants live in the database, not in memory**, so several replicas
  can serve one flow.
- **Changing the domain** in `NUXT_PUBLIC_APP_URL` changes the issuer and the
  resource, and every OAuth client has to connect again. Static tokens are
  unaffected.
