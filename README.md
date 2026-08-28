# TXP Xero MCP connector

Permanent, self-hosted Xero MCP server for The Expert Project.

- Dashboard: `https://txp.densetsuph.com/` (password protected)
- MCP endpoint: `POST https://txp.densetsuph.com/mcp` (bearer token)
- Health: `https://txp.densetsuph.com/health` (public, no secrets)

## How it works

`server.js` boots an Express app with three surfaces: the MCP Streamable HTTP
endpoint, the admin dashboard, and a health probe.

| File | Role |
| --- | --- |
| `src/store.js` | AES-256-GCM encrypted JSON state, atomic + serialised writes |
| `src/xero.js` | OAuth 2.0 authorization-code flow, rotating refresh tokens, API client |
| `src/tools.js` | Declarative registry of 70 Xero tools |
| `src/mcp.js` | JSON-RPC 2.0 / MCP protocol handling (stateless Streamable HTTP) |
| `src/dashboard.js` | Admin UI: credentials, connect/reconnect, tenants, token |

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | Dashboard sign-in |
| `ENCRYPTION_KEY` | yes | Encrypts stored Xero secrets and tokens at rest |
| `SESSION_SECRET` | yes | Signs dashboard session cookies |
| `DATA_DIR` | yes | State directory, kept **outside** `public_html` so redeploys don't wipe it |
| `PUBLIC_URL` | yes | Canonical base URL, used to build the OAuth redirect URI |
| `PORT` | auto | Supplied by the host |

Changing `ENCRYPTION_KEY` makes existing stored tokens unreadable — the Xero
connection then has to be re-authorised from the dashboard.

## Token lifecycle

Xero access tokens last 30 minutes and refresh tokens last 60 days, rotating on
every use. The API client refreshes on demand (with a shared in-flight promise
so concurrent tool calls cannot race), persists the rotated refresh token
immediately, and retries once on a 401. A keep-alive timer also refreshes every
6 hours so the 60-day window never lapses on a quiet server.

## Adding a tool

Append an entry to the array in `src/tools.js`:

```js
{
  name: 'xero_list_widgets',
  title: 'List widgets',
  description: 'What the model needs to know to use this well.',
  inputSchema: listSchema(),
  handler: listHandler('Widgets'),
}
```

Anything not worth a dedicated tool is already reachable through
`xero_api_request`.
