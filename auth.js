import { config } from './config.js';
import { request, joinUrl } from './http.js';

let cached = { token: null, expiresAt: 0 };

function dig(obj, dotted) {
  return dotted
    .split('.')
    .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function extractToken(payload) {
  if (typeof payload === 'string' && payload.trim()) return payload.trim().replace(/^"|"$/g, '');
  if (!payload || typeof payload !== 'object') return null;
  for (const path of config.auth.tokenPath) {
    const v = dig(payload, path);
    if (typeof v === 'string' && v.length > 8) return v;
  }
  // Last resort: any string field whose name smells like a token.
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' && v.length > 20 && /token|jwt|session|ticket/i.test(k)) return v;
  }
  return null;
}

async function login() {
  const { username, password, loginPath, loginMethod, loginBody } = config.auth;
  if (!username || !password) {
    throw new Error(
      'USTORE_AUTH_MODE=login requires USTORE_USERNAME and USTORE_PASSWORD.'
    );
  }

  const body = loginBody
    .replaceAll('{{username}}', JSON.stringify(username).slice(1, -1))
    .replaceAll('{{password}}', JSON.stringify(password).slice(1, -1));

  const res = await request(joinUrl(config.baseUrl, loginPath), {
    method: loginMethod,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body
  });

  if (!res.ok) {
    throw new Error(
      `Login failed: ${res.status} ${res.statusText} at ${loginPath}. ` +
        `Body: ${res.text.slice(0, 400)}`
    );
  }

  const token = extractToken(res.json ?? res.text);
  if (!token) {
    throw new Error(
      `Login succeeded (${res.status}) but no token found. Set USTORE_TOKEN_PATH. ` +
        `Response keys: ${res.json ? Object.keys(res.json).join(', ') : '(non-JSON)'}`
    );
  }

  cached = {
    token,
    expiresAt: config.auth.ttlSeconds
      ? Date.now() + config.auth.ttlSeconds * 1000
      : Number.MAX_SAFE_INTEGER
  };
  return token;
}

/** Returns the header object to merge into an outbound request. */
export async function authHeaders({ force = false } = {}) {
  const { mode, header, scheme, token: staticToken } = config.auth;

  if (mode === 'none') return {};

  if (mode === 'basic') {
    const b64 = Buffer.from(
      `${config.auth.username}:${config.auth.password}`
    ).toString('base64');
    return { [header]: `Basic ${b64}` };
  }

  if (mode === 'bearer' || mode === 'apikey') {
    if (!staticToken) throw new Error('USTORE_TOKEN / USTORE_API_KEY is not set.');
    return { [header]: scheme ? `${scheme} ${staticToken}` : staticToken };
  }

  // mode === 'login'
  if (force || !cached.token || Date.now() >= cached.expiresAt) {
    await login();
  }
  return { [header]: scheme ? `${scheme} ${cached.token}` : cached.token };
}

export function invalidate() {
  cached = { token: null, expiresAt: 0 };
}

export function status() {
  return {
    mode: config.auth.mode,
    hasToken: Boolean(cached.token || config.auth.token),
    header: config.auth.header,
    scheme: config.auth.scheme || '(raw)'
  };
}
