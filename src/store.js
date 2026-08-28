// Encrypted-at-rest JSON state store.
// The whole state blob is encrypted with AES-256-GCM using a key derived from
// ENCRYPTION_KEY. Writes are atomic (tmp file + rename) and serialised through
// a promise chain so concurrent token refreshes cannot interleave.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.enc');
const KEY_FILE = path.join(DATA_DIR, 'key');

const EMPTY = {
  credentials: null, // { clientId, clientSecret, scopes }
  tokens: null,      // { access_token, refresh_token, expires_at, scope }
  tenants: [],       // [{ tenantId, tenantName, tenantType }]
  defaultTenantId: null,
  mcpToken: null,
  connectedAt: null,
  lastRefreshAt: null,
  lastError: null,
};

let keyPromise = null;
let cache = null;
let chain = Promise.resolve();

async function getKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    let secret = process.env.ENCRYPTION_KEY;
    if (!secret) {
      // Fall back to a key file so the app still protects data at rest even if
      // the env var was never set. Losing this file means re-entering secrets.
      try {
        secret = (await fs.readFile(KEY_FILE, 'utf8')).trim();
      } catch {
        secret = crypto.randomBytes(32).toString('hex');
        await fs.writeFile(KEY_FILE, secret, { mode: 0o600 });
      }
    }
    return crypto.scryptSync(secret, 'txp-xero-mcp-v1', 32);
  })();
  return keyPromise;
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(key, payload) {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export async function read() {
  if (cache) return cache;
  const key = await getKey();
  try {
    const payload = await fs.readFile(STATE_FILE, 'utf8');
    cache = { ...EMPTY, ...JSON.parse(decrypt(key, payload.trim())) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] could not read state, starting fresh:', err.message);
    }
    cache = { ...EMPTY };
  }
  return cache;
}

/**
 * Serialised read-modify-write. `mutator` receives the current state and may
 * mutate it in place or return a replacement object.
 */
export function update(mutator) {
  chain = chain.then(async () => {
    const key = await getKey();
    const current = await read();
    const next = (await mutator(current)) || current;
    cache = next;
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, encrypt(key, JSON.stringify(next)), { mode: 0o600 });
    await fs.rename(tmp, STATE_FILE);
    return next;
  });
  return chain;
}

export const dataDir = DATA_DIR;
