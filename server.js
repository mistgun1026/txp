// TXP Xero MCP connector
// - GET  /            admin dashboard (password protected)
// - POST /mcp         MCP Streamable HTTP endpoint (bearer token protected)
// - GET  /health      unauthenticated liveness + connection status

import crypto from 'node:crypto';
import express from 'express';
import * as store from './src/store.js';
import * as xero from './src/xero.js';
import { createDashboard } from './src/dashboard.js';
import { handlePost, SERVER_NAME, SERVER_VERSION } from './src/mcp.js';
import { tools } from './src/tools.js';

const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ------------------------------------------------------------------- MCP auth

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function presentedToken(req) {
  const header = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}

async function requireMcpToken(req, res, next) {
  const state = await store.read();
  const supplied = presentedToken(req);
  if (!state.mcpToken || !supplied || !timingSafeEqual(supplied, state.mcpToken)) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="txp-xero-mcp"')
      .json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message:
            'Unauthorized. Send the MCP bearer token in the Authorization header (Authorization: Bearer <token>).',
        },
      });
    return;
  }
  next();
}

// ---------------------------------------------------------------- MCP routing

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

app.options('/mcp', (req, res) => res.set(CORS_HEADERS).status(204).end());

app.post('/mcp', (req, res, next) => {
  res.set(CORS_HEADERS);
  next();
}, requireMcpToken, handlePost);

// This server is stateless, so there is no server-initiated stream to open and
// no session to terminate. Both are optional in the spec; 405 is the correct
// way to say so.
app.get('/mcp', requireMcpToken, (req, res) => {
  res
    .status(405)
    .set('Allow', 'POST, OPTIONS')
    .json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'This server is stateless: send JSON-RPC requests with POST /mcp.',
      },
    });
});

app.delete('/mcp', requireMcpToken, (req, res) => res.status(204).end());

// --------------------------------------------------------------------- health

app.get('/health', async (req, res) => {
  const state = await store.read();
  res.json({
    status: 'ok',
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    tools: tools.length,
    xero: {
      credentialsSaved: Boolean(state.credentials),
      connected: Boolean(state.tokens),
      organisations: state.tenants.map((t) => t.tenantName),
      defaultOrganisation:
        state.tenants.find((t) => t.tenantId === state.defaultTenantId)?.tenantName || null,
      lastRefreshAt: state.lastRefreshAt,
      needsReconnect: Boolean(state.lastError?.needsReconnect),
    },
  });
});

// No OAuth discovery: this endpoint uses a static bearer token, so clients
// should not try to negotiate an authorization server.
app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource'], (req, res) =>
  res.status(404).json({ error: 'not_supported', detail: 'Use a static bearer token on POST /mcp.' }),
);

// ------------------------------------------------------------------ dashboard

app.use(createDashboard());

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

// ----------------------------------------------------------------- boot-strap

async function boot() {
  const state = await store.read();
  if (!state.mcpToken) {
    await store.update((s) => {
      s.mcpToken = crypto.randomBytes(32).toString('base64url');
      return s;
    });
    console.log('[boot] generated a new MCP bearer token (visible on the dashboard)');
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[boot] ADMIN_PASSWORD is not set — the dashboard cannot be signed into.');
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('[boot] ENCRYPTION_KEY is not set — falling back to a key file in the data directory.');
  }

  xero.startKeepAlive();

  app.listen(PORT, () => {
    console.log(`[boot] ${SERVER_NAME} v${SERVER_VERSION} listening on ${PORT}`);
    console.log(`[boot] ${tools.length} Xero tools registered; data dir ${store.dataDir}`);
  });
}

boot().catch((err) => {
  console.error('[boot] failed to start:', err);
  process.exit(1);
});
