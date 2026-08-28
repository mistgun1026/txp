// Password-protected admin dashboard: store Xero app credentials, run the
// OAuth connect/reconnect flow, inspect token + tenant status, and manage the
// MCP bearer token.

import crypto from 'node:crypto';
import express from 'express';
import * as store from './store.js';
import * as xero from './xero.js';
import { tools } from './tools.js';

const COOKIE = 'txp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY || 'txp-dev-secret-change-me';
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function issueSession(res) {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  const cookie = `${payload}.${sign(payload)}`;
  res.cookie(COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
}

function hasSession(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return false;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }
  return Number(payload) > Date.now();
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}

function redirectUri(req) {
  return `${baseUrl(req)}/oauth/callback`;
}

// ------------------------------------------------------------------ rendering

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const STYLE = `
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--line:#2a2f3a;--text:#e6e8ee;--dim:#9aa3b2;--accent:#4f8cff;--ok:#31c48d;--warn:#f0a53e;--bad:#f26d6d;--radius:10px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:40px 22px 80px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.2px}
h2{font-size:15px;margin:0 0 14px;letter-spacing:.02em;text-transform:uppercase;color:var(--dim)}
.sub{color:var(--dim);margin:0 0 30px;font-size:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px;margin-bottom:18px}
label{display:block;font-size:13px;color:var(--dim);margin:14px 0 6px}
input[type=text],input[type=password],textarea,select{width:100%;padding:10px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);font:inherit;font-size:14px}
textarea{min-height:76px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
button,.btn{display:inline-block;margin-top:16px;padding:10px 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{border-color:var(--accent)}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.danger:hover{border-color:var(--bad);color:var(--bad)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;font-size:13px;font-weight:600;background:var(--panel2);border:1px solid var(--line)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--dim)}
.pill.ok{color:var(--ok)}.pill.ok .dot{background:var(--ok)}
.pill.warn{color:var(--warn)}.pill.warn .dot{background:var(--warn)}
.pill.bad{color:var(--bad)}.pill.bad .dot{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:none}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.copy{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:11px 13px;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:13px;margin-top:6px}
.dl{display:grid;grid-template-columns:180px 1fr;gap:9px 16px;font-size:14px}
.dl dt{color:var(--dim)}
.dl dd{margin:0;word-break:break-all}
.flash{padding:12px 14px;border-radius:8px;margin-bottom:18px;font-size:14px;border:1px solid}
.flash.ok{background:rgba(49,196,141,.1);border-color:rgba(49,196,141,.35);color:#8ee5c0}
.flash.bad{background:rgba(242,109,109,.1);border-color:rgba(242,109,109,.35);color:#f4a3a3}
.hint{color:var(--dim);font-size:13px;margin-top:10px}
.hint a{color:var(--accent)}
ol{padding-left:20px;color:var(--dim);font-size:14px}
ol li{margin-bottom:7px}
ol code{color:var(--text)}
hr{border:none;border-top:1px solid var(--line);margin:22px 0}
@media(max-width:640px){.dl{grid-template-columns:1fr;gap:2px 0}.dl dt{margin-top:8px}}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function flash(req) {
  const ok = req.query.ok;
  const err = req.query.err;
  if (ok) return `<div class="flash ok">${esc(ok)}</div>`;
  if (err) return `<div class="flash bad">${esc(err)}</div>`;
  return '';
}

function loginPage(req) {
  return page(
    'Sign in · TXP Xero MCP',
    `<h1>TXP Xero MCP</h1>
     <p class="sub">Sign in to manage the Xero connection.</p>
     ${flash(req)}
     <div class="card">
       <form method="post" action="/login">
         <label for="password">Admin password</label>
         <input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
         <button class="primary" type="submit">Sign in</button>
       </form>
     </div>`,
  );
}

function relative(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function statusPill(state) {
  if (!state.credentials) return '<span class="pill bad"><span class="dot"></span>No app credentials</span>';
  if (!state.tokens) return '<span class="pill warn"><span class="dot"></span>Not connected</span>';
  if (state.lastError?.needsReconnect) {
    return '<span class="pill bad"><span class="dot"></span>Reconnect needed</span>';
  }
  return '<span class="pill ok"><span class="dot"></span>Connected</span>';
}

function dashboardPage(req, state) {
  const base = baseUrl(req);
  const uri = redirectUri(req);
  const creds = state.credentials;
  const tokens = state.tokens;
  const expiresIn = tokens ? Math.round((tokens.expires_at - Date.now()) / 60000) : null;

  const tenantRows = state.tenants.length
    ? state.tenants
        .map(
          (t) => `<tr>
            <td>${esc(t.tenantName)}</td>
            <td class="mono">${esc(t.tenantId)}</td>
            <td>${t.tenantId === state.defaultTenantId ? '<span class="pill ok"><span class="dot"></span>Default</span>' : `<form method="post" action="/default-tenant" style="margin:0"><input type="hidden" name="tenantId" value="${esc(t.tenantId)}"><button type="submit" style="margin:0;padding:5px 11px;font-size:13px">Make default</button></form>`}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="3" style="color:var(--dim)">No organisations connected yet.</td></tr>';

  return page(
    'TXP Xero MCP',
    `<h1>TXP Xero MCP</h1>
     <p class="sub">${esc(base)} · ${tools.length} tools · <a href="/logout" style="color:var(--dim)">sign out</a></p>
     ${flash(req)}

     <div class="card">
       <h2>Status</h2>
       <div class="row">
         ${statusPill(state)}
         ${tokens ? `<span class="pill"><span class="dot"></span>Access token ${expiresIn > 0 ? `valid ${expiresIn} min` : 'expired, will auto-refresh'}</span>` : ''}
       </div>
       <hr>
       <dl class="dl">
         <dt>Connected</dt><dd>${state.connectedAt ? `${esc(new Date(state.connectedAt).toUTCString())} (${relative(state.connectedAt)})` : '—'}</dd>
         <dt>Last token refresh</dt><dd>${state.lastRefreshAt ? `${esc(new Date(state.lastRefreshAt).toUTCString())} (${relative(state.lastRefreshAt)})` : '—'}</dd>
         <dt>Granted scopes</dt><dd class="mono" style="font-size:12px">${esc(tokens?.scope || '—')}</dd>
         ${state.lastError ? `<dt>Last error</dt><dd style="color:var(--bad)">${esc(state.lastError.message)} <span style="color:var(--dim)">(${relative(state.lastError.at)})</span></dd>` : ''}
       </dl>
       <div class="row">
         <form method="post" action="/connect" style="margin:0">
           <button class="primary" type="submit"${creds ? '' : ' disabled'}>${tokens ? 'Reconnect to Xero' : 'Connect to Xero'}</button>
         </form>
         <form method="post" action="/refresh" style="margin:0">
           <button type="submit"${tokens ? '' : ' disabled'}>Refresh token now</button>
         </form>
         <form method="post" action="/disconnect" style="margin:0" onsubmit="return confirm('Disconnect Xero? You will need to authorise again.')">
           <button class="danger" type="submit"${tokens ? '' : ' disabled'}>Disconnect</button>
         </form>
       </div>
       ${creds ? '' : '<p class="hint">Save your Xero app credentials below first.</p>'}
     </div>

     <div class="card">
       <h2>Xero app credentials</h2>
       <p class="hint" style="margin-top:0">From your app in the <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener">Xero developer portal</a>. Add this exact redirect URI to that app:</p>
       <div class="copy">${esc(uri)}</div>
       <form method="post" action="/credentials">
         <label for="clientId">Client ID</label>
         <input id="clientId" type="text" name="clientId" value="${esc(creds?.clientId || '')}" autocomplete="off" required>
         <label for="clientSecret">Client secret</label>
         <input id="clientSecret" type="password" name="clientSecret" placeholder="${creds ? 'saved — leave blank to keep' : ''}" autocomplete="off"${creds ? '' : ' required'}>
         <label for="scopes">Scopes</label>
         <textarea id="scopes" name="scopes">${esc(creds?.scopes || xero.DEFAULT_SCOPES)}</textarea>
         <p class="hint">Trim any scopes your Xero app is not enabled for — Xero rejects the whole authorisation if one is not permitted. <code>offline_access</code> must stay, it is what allows permanent unattended access.</p>
         <button class="primary" type="submit">Save credentials</button>
       </form>
     </div>

     <div class="card">
       <h2>Organisations</h2>
       <table><thead><tr><th>Name</th><th>Tenant ID</th><th></th></tr></thead><tbody>${tenantRows}</tbody></table>
       <p class="hint">Tools use the default organisation unless a <code>tenantId</code> is passed.</p>
     </div>

     <div class="card">
       <h2>MCP endpoint</h2>
       <p class="hint" style="margin-top:0">Server URL</p>
       <div class="copy">${esc(base)}/mcp</div>
       <p class="hint">Authorization header</p>
       <div class="copy">Bearer ${esc(state.mcpToken || '—')}</div>
       <p class="hint">In Composio Custom MCP: transport <code>Streamable HTTP</code>, the URL above, and a custom header <code>Authorization</code> with the value <code>Bearer &lt;token&gt;</code>. Requests without it get a 401.</p>
       <form method="post" action="/rotate-token" onsubmit="return confirm('Rotate the MCP token? Any client using the old token will stop working until you update it.')">
         <button class="danger" type="submit">Rotate token</button>
       </form>
     </div>

     <div class="card">
       <h2>First-time setup</h2>
       <ol>
         <li>In the Xero developer portal, create (or open) an app and add the redirect URI shown above.</li>
         <li>Paste the client ID and secret here and save.</li>
         <li>Click <strong>Connect to Xero</strong> and pick the organisation(s) to share.</li>
         <li>Copy the MCP URL and bearer token into Composio Custom MCP.</li>
       </ol>
       <p class="hint">Tokens refresh themselves; the server also refreshes every 6 hours so the 60-day refresh window never lapses. Come back here only if the status shows <em>Reconnect needed</em>.</p>
     </div>`,
  );
}

// -------------------------------------------------------------------- routing

export function createDashboard() {
  const router = express.Router();

  router.use((req, res, next) => {
    // Minimal cookie parsing — avoids pulling in cookie-parser.
    req.cookies = Object.fromEntries(
      String(req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const index = part.indexOf('=');
          return index === -1
            ? [part, '']
            : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
        }),
    );
    next();
  });

  router.get('/login', (req, res) => {
    if (hasSession(req)) return res.redirect('/');
    res.type('html').send(loginPage(req));
  });

  router.post('/login', (req, res) => {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      return res.redirect('/login?err=' + encodeURIComponent('ADMIN_PASSWORD is not set on the server.'));
    }
    const supplied = String(req.body?.password || '');
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      return res.redirect('/login?err=' + encodeURIComponent('Incorrect password.'));
    }
    issueSession(res);
    res.redirect('/');
  });

  router.get('/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  // Everything below requires a session.
  const guard = (req, res, next) => {
    if (!hasSession(req)) return res.redirect('/login');
    next();
  };

  router.get('/', guard, async (req, res) => {
    const state = await store.read();
    res.type('html').send(dashboardPage(req, state));
  });

  router.post('/credentials', guard, async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    const scopes = String(req.body?.scopes || '').trim() || xero.DEFAULT_SCOPES;
    if (!clientId) return res.redirect('/?err=' + encodeURIComponent('Client ID is required.'));

    const state = await store.read();
    const secret = clientSecret || state.credentials?.clientSecret;
    if (!secret) return res.redirect('/?err=' + encodeURIComponent('Client secret is required.'));

    await store.update((s) => {
      s.credentials = { clientId, clientSecret: secret, scopes };
      return s;
    });
    res.redirect('/?ok=' + encodeURIComponent('Credentials saved. Now click Connect to Xero.'));
  });

  router.post('/connect', guard, async (req, res) => {
    const state = await store.read();
    if (!state.credentials) return res.redirect('/?err=' + encodeURIComponent('Save credentials first.'));
    const url = xero.buildAuthorizeUrl({
      clientId: state.credentials.clientId,
      scopes: state.credentials.scopes,
      redirectUri: redirectUri(req),
      state: xero.createState('/'),
    });
    res.redirect(url);
  });

  // Xero redirects the browser back here. Session-guarded so a stray callback
  // cannot be replayed by anyone else; the state parameter is single-use.
  router.get('/oauth/callback', guard, async (req, res) => {
    const { code, state: stateParam, error: oauthError, error_description: description } = req.query;
    if (oauthError) {
      return res.redirect('/?err=' + encodeURIComponent(`Xero returned "${oauthError}": ${description || ''}`));
    }
    if (!code || !stateParam || !xero.consumeState(String(stateParam))) {
      return res.redirect('/?err=' + encodeURIComponent('Authorisation link was invalid or expired. Try again.'));
    }
    try {
      const tenants = await xero.exchangeCode({ code: String(code), redirectUri: redirectUri(req) });
      const names = tenants.map((t) => t.tenantName).join(', ') || 'no organisations';
      res.redirect('/?ok=' + encodeURIComponent(`Connected to Xero: ${names}.`));
    } catch (err) {
      res.redirect('/?err=' + encodeURIComponent(err.message));
    }
  });

  router.post('/refresh', guard, async (req, res) => {
    try {
      await xero.getAccessToken({ force: true });
      res.redirect('/?ok=' + encodeURIComponent('Token refreshed.'));
    } catch (err) {
      res.redirect('/?err=' + encodeURIComponent(err.message));
    }
  });

  router.post('/disconnect', guard, async (req, res) => {
    try {
      await xero.revoke();
      res.redirect('/?ok=' + encodeURIComponent('Disconnected from Xero.'));
    } catch (err) {
      res.redirect('/?err=' + encodeURIComponent(err.message));
    }
  });

  router.post('/default-tenant', guard, async (req, res) => {
    const tenantId = String(req.body?.tenantId || '');
    await store.update((s) => {
      if (s.tenants.some((t) => t.tenantId === tenantId)) s.defaultTenantId = tenantId;
      return s;
    });
    res.redirect('/?ok=' + encodeURIComponent('Default organisation updated.'));
  });

  router.post('/rotate-token', guard, async (req, res) => {
    await store.update((s) => {
      s.mcpToken = crypto.randomBytes(32).toString('base64url');
      return s;
    });
    res.redirect('/?ok=' + encodeURIComponent('MCP token rotated. Update Composio with the new value.'));
  });

  return router;
}
