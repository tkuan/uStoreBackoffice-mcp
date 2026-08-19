import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Precedence: the real environment, then a .env in the working directory, then
// the .env sitting next to this file. dotenv never overwrites an already-set
// variable, so earlier sources win. The module-local file matters because
// Claude Desktop (and launchd) start us with cwd=/ and a near-empty
// environment — a cwd-relative .env would silently resolve to nothing.
dotenv.config();
dotenv.config({ path: path.join(HERE, '.env') });

const bool = (v, d = false) =>
  v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v));

const num = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const csv = (v) =>
  v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];

const regexList = (v) => csv(v).map((p) => new RegExp(p, 'i'));

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

export const config = {
  // ---- Target API -------------------------------------------------------
  baseUrl: stripSlash(
    process.env.USTORE_BASE_URL ||
      'https://produproduce.mysite.com/ustorebackofficerestapi'
  ),
  // Explicit spec URL. If unset we probe the candidates below.
  specUrl: process.env.USTORE_SPEC_URL || null,
  specCandidates: csv(process.env.USTORE_SPEC_CANDIDATES).length
    ? csv(process.env.USTORE_SPEC_CANDIDATES)
    : [
        '/swagger/v1/swagger.json',
        '/swagger/docs/v1',
        '/swagger/v1/swagger.yaml',
        '/openapi.json',
        '/swagger.json'
      ],

  // ---- TLS --------------------------------------------------------------
  tlsInsecure: bool(process.env.USTORE_TLS_INSECURE, false),
  caFile: process.env.USTORE_CA_FILE || null,

  // ---- Auth -------------------------------------------------------------
  // mode: login | bearer | apikey | basic | none
  auth: {
    mode: (process.env.USTORE_AUTH_MODE || 'login').toLowerCase(),
    username: process.env.USTORE_USERNAME || '',
    password: process.env.USTORE_PASSWORD || '',
    // Static token (mode=bearer) or API key (mode=apikey)
    token: process.env.USTORE_TOKEN || process.env.USTORE_API_KEY || '',
    // Login handshake (mode=login)
    loginPath: process.env.USTORE_LOGIN_PATH || '/v1/admin/auth/login',
    loginMethod: (process.env.USTORE_LOGIN_METHOD || 'POST').toUpperCase(),
    // JSON body template; {{username}} / {{password}} are substituted.
    loginBody:
      process.env.USTORE_LOGIN_BODY ||
      '{"email":"{{username}}","password":"{{password}}"}',
    // Dot path into the login response JSON where the token lives.
    // Multiple candidates may be given comma-separated; first hit wins.
    tokenPath: csv(process.env.USTORE_TOKEN_PATH).length
      ? csv(process.env.USTORE_TOKEN_PATH)
      : ['Token', 'token', 'access_token', 'accessToken', 'data.token', 'result.token'],
    // How the credential is attached to subsequent requests.
    header: process.env.USTORE_AUTH_HEADER || 'Authorization',
    scheme: process.env.USTORE_AUTH_SCHEME ?? 'uStoreBackoffice',
    // Re-login this many seconds before assumed expiry (0 = only on 401).
    ttlSeconds: num(process.env.USTORE_TOKEN_TTL_SECONDS, 0)
  },

  // ---- Safety -----------------------------------------------------------
  allowWrites: bool(process.env.USTORE_ALLOW_WRITES, false),
  // Even with writes enabled, these paths are always refused.
  denyPaths: regexList(
    process.env.USTORE_DENY_PATHS || '/delete,/purge,/reset,/uninstall'
  ),
  // If set, only paths matching one of these are callable at all.
  allowPaths: regexList(process.env.USTORE_ALLOW_PATHS || ''),

  // ---- Limits -----------------------------------------------------------
  requestTimeoutMs: num(process.env.USTORE_TIMEOUT_MS, 60000),
  maxResponseChars: num(process.env.USTORE_MAX_RESPONSE_CHARS, 60000),
  specRefreshMs: num(process.env.USTORE_SPEC_REFRESH_MS, 15 * 60 * 1000),

  // ---- MCP transport ----------------------------------------------------
  transport: (process.env.MCP_TRANSPORT || 'stdio').toLowerCase(),
  host: process.env.MCP_HOST || '127.0.0.1',
  port: num(process.env.MCP_PORT, 8931),
  // Optional shared secret checked on the HTTP transport (HAProxy can also
  // enforce this, but defence in depth is cheap).
  bearerGuard: process.env.MCP_BEARER_TOKEN || ''
};

export function ca() {
  if (!config.caFile) return null;
  try {
    // Same cwd problem as the .env above: resolve against this file, not cwd.
    return fs.readFileSync(path.resolve(HERE, config.caFile));
  } catch (err) {
    console.error(`[config] cannot read USTORE_CA_FILE: ${err.message}`);
    return null;
  }
}

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
