// Xero OAuth 2.0 (authorization code + rotating refresh token) and API client.

import crypto from 'node:crypto';
import * as store from './store.js';

export const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const TOKEN_URL = 'https://identity.xero.com/connect/token';
export const CONNECTIONS_URL = 'https://api.xero.com/connections';
export const REVOKE_URL = 'https://identity.xero.com/connect/revocation';
export const API_HOST = 'https://api.xero.com';

export const DEFAULT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.transactions',
  'accounting.contacts',
  'accounting.settings',
  'accounting.reports.read',
  'accounting.journals.read',
  'accounting.attachments',
  'accounting.budgets.read',
  'files',
  'assets',
  'projects',
  'payroll.employees',
  'payroll.payruns',
  'payroll.payslip',
  'payroll.timesheets',
  'payroll.settings',
].join(' ');

export class XeroError extends Error {
  constructor(message, { status, body, needsReconnect = false } = {}) {
    super(message);
    this.name = 'XeroError';
    this.status = status;
    this.body = body;
    this.needsReconnect = needsReconnect;
  }
}

// ---------------------------------------------------------------- OAuth state

const pendingStates = new Map();

export function createState(returnTo = '/') {
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, { returnTo, expiresAt: Date.now() + 15 * 60 * 1000 });
  for (const [key, value] of pendingStates) {
    if (value.expiresAt < Date.now()) pendingStates.delete(key);
  }
  return state;
}

export function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ------------------------------------------------------------------ Token I/O

function basicAuth(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function postToken(credentials, params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(credentials.clientId, credentials.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json.error_description || json.error || text || res.statusText;
    throw new XeroError(`Xero token request failed (${res.status}): ${detail}`, {
      status: res.status,
      body: json,
      needsReconnect: res.status === 400 || res.status === 401,
    });
  }
  return json;
}

export function buildAuthorizeUrl({ clientId, scopes, redirectUri, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes || DEFAULT_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

function tokenRecord(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    // Renew a minute early to avoid racing the expiry.
    expires_at: Date.now() + (Number(token.expires_in || 1800) * 1000),
  };
}

export async function exchangeCode({ code, redirectUri }) {
  const state = await store.read();
  if (!state.credentials) throw new XeroError('No Xero app credentials have been saved yet.');
  const token = await postToken(state.credentials, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const tenants = await fetchConnections(token.access_token);
  await store.update((s) => {
    s.tokens = tokenRecord(token);
    s.tenants = tenants;
    s.defaultTenantId = tenants.find((t) => t.tenantId === s.defaultTenantId)
      ? s.defaultTenantId
      : (tenants[0]?.tenantId || null);
    s.connectedAt = new Date().toISOString();
    s.lastRefreshAt = new Date().toISOString();
    s.lastError = null;
    return s;
  });
  return tenants;
}

let refreshInFlight = null;

async function doRefresh() {
  const state = await store.read();
  if (!state.credentials) throw new XeroError('No Xero app credentials have been saved yet.');
  if (!state.tokens?.refresh_token) {
    throw new XeroError('Xero is not connected. Open the dashboard and click Connect to Xero.', {
      needsReconnect: true,
    });
  }
  try {
    const token = await postToken(state.credentials, {
      grant_type: 'refresh_token',
      refresh_token: state.tokens.refresh_token,
    });
    const tenants = await fetchConnections(token.access_token);
    await store.update((s) => {
      s.tokens = tokenRecord(token);
      if (tenants.length) {
        s.tenants = tenants;
        if (!tenants.some((t) => t.tenantId === s.defaultTenantId)) {
          s.defaultTenantId = tenants[0].tenantId;
        }
      }
      s.lastRefreshAt = new Date().toISOString();
      s.lastError = null;
      return s;
    });
    return token.access_token;
  } catch (err) {
    await store.update((s) => {
      s.lastError = {
        at: new Date().toISOString(),
        message: err.message,
        needsReconnect: Boolean(err.needsReconnect),
      };
      return s;
    });
    throw err;
  }
}

/** Returns a valid access token, refreshing (once, shared) if needed. */
export async function getAccessToken({ force = false } = {}) {
  const state = await store.read();
  if (!state.tokens) {
    throw new XeroError('Xero is not connected yet.', { needsReconnect: true });
  }
  if (!force && Date.now() < state.tokens.expires_at) return state.tokens.access_token;
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function fetchConnections(accessToken) {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new XeroError(`Could not list Xero connections (${res.status}): ${body}`, { status: res.status });
  }
  const list = await res.json();
  return list.map((c) => ({
    tenantId: c.tenantId,
    tenantName: c.tenantName,
    tenantType: c.tenantType,
    connectionId: c.id,
  }));
}

export async function revoke() {
  const state = await store.read();
  if (state.credentials && state.tokens?.refresh_token) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(state.credentials.clientId, state.credentials.clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: state.tokens.refresh_token }).toString(),
      });
    } catch (err) {
      console.error('[xero] revocation failed (continuing):', err.message);
    }
  }
  await store.update((s) => {
    s.tokens = null;
    s.tenants = [];
    s.defaultTenantId = null;
    s.connectedAt = null;
    s.lastError = null;
    return s;
  });
}

// ------------------------------------------------------------------ API calls

async function resolveTenantId(requested) {
  const state = await store.read();
  if (requested) {
    const match = state.tenants.find(
      (t) => t.tenantId === requested || t.tenantName?.toLowerCase() === String(requested).toLowerCase(),
    );
    return match ? match.tenantId : requested;
  }
  if (state.defaultTenantId) return state.defaultTenantId;
  if (state.tenants.length === 1) return state.tenants[0].tenantId;
  if (state.tenants.length > 1) {
    throw new XeroError(
      `Several Xero organisations are connected and no default is set. Pass tenantId, or set a default on the dashboard. Available: ${state.tenants
        .map((t) => `${t.tenantName} (${t.tenantId})`)
        .join(', ')}`,
    );
  }
  throw new XeroError('No Xero organisation is connected yet.', { needsReconnect: true });
}

/**
 * Call the Xero API.
 * @param {object} opts
 * @param {string} [opts.method]   HTTP method, default GET.
 * @param {string} opts.path       Either "Invoices" (accounting API) or a full
 *                                 API path like "payroll.xro/2.0/Employees".
 * @param {object} [opts.query]    Query parameters.
 * @param {object} [opts.body]     JSON body.
 * @param {object} [opts.headers]  Extra headers.
 * @param {string} [opts.tenantId]
 */
export async function api({ method = 'GET', path, query, body, headers = {}, tenantId, retry = true }) {
  const accessToken = await getAccessToken();
  const resolvedTenant = await resolveTenantId(tenantId);

  let cleanPath = String(path || '').replace(/^\/+/, '');
  if (!/^(api|payroll|files|assets|projects|bankfeeds|finance|practicemanager)\.xro\//i.test(cleanPath)) {
    cleanPath = `api.xro/2.0/${cleanPath}`;
  }
  const url = new URL(`${API_HOST}/${cleanPath}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': resolvedTenant,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (res.status === 401 && retry) {
    // Access token rejected mid-flight: force one refresh and try again.
    await getAccessToken({ force: true });
    return api({ method, path, query, body, headers, tenantId, retry: false });
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    throw new XeroError(
      `Xero rate limit hit. Retry after ${retryAfter || 'a few'} seconds.`,
      { status: 429, body: json },
    );
  }

  if (!res.ok) {
    const detail =
      json?.Detail ||
      json?.Message ||
      json?.detail ||
      (json?.Elements ? JSON.stringify(json.Elements) : null) ||
      text ||
      res.statusText;
    throw new XeroError(`Xero API ${method} ${cleanPath} failed (${res.status}): ${detail}`, {
      status: res.status,
      body: json,
    });
  }

  return json;
}

/** Keeps the 60-day rolling refresh token alive on a long-lived server. */
export function startKeepAlive(intervalMs = 6 * 60 * 60 * 1000) {
  const tick = async () => {
    try {
      const state = await store.read();
      if (!state.tokens?.refresh_token) return;
      await getAccessToken({ force: true });
      console.log('[xero] keep-alive refresh ok');
    } catch (err) {
      console.error('[xero] keep-alive refresh failed:', err.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
