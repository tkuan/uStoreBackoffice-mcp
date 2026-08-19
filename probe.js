#!/usr/bin/env node
/**
 * Run this ON THE INTERNAL NETWORK before wiring up the MCP server.
 * It discovers the OpenAPI document URL and the login handshake, then prints
 * the exact .env values to use.
 *
 *   npm run probe
 */
import { config } from './config.js';
import { request, joinUrl } from './http.js';

const LOGIN_PATHS = [
  '/v1/admin/auth/login', // confirmed for this deployment
  '/api/Account/Login',
  '/api/Auth/Login',
  '/api/Authentication/Login',
  '/api/Login',
  '/api/token',
  '/api/v1/Account/Login',
  '/Account/Login'
];

const BODY_SHAPES = [
  (u, p) => ({ label: 'email/password', body: { email: u, password: p } }), // confirmed
  (u, p) => ({ label: 'username/password', body: { username: u, password: p } }),
  (u, p) => ({ label: 'Username/Password', body: { Username: u, Password: p } }),
  (u, p) => ({ label: 'userName/password', body: { userName: u, password: p } }),
  (u, p) => ({ label: 'login/password', body: { login: u, password: p } })
];

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function findSpec() {
  console.log(`\n== 1. Locating the OpenAPI document ==`);
  const candidates = config.specUrl
    ? [config.specUrl]
    : config.specCandidates.map((p) => joinUrl(config.baseUrl, p));

  for (const url of candidates) {
    try {
      const res = await request(url, { headers: { accept: '*/*' } });
      const isSpec = res.json && (res.json.paths || res.json.swagger || res.json.openapi);
      if (isSpec) {
        const count = Object.values(res.json.paths || {}).reduce(
          (n, item) =>
            n +
            Object.keys(item).filter((k) =>
              ['get', 'post', 'put', 'delete', 'patch'].includes(k)
            ).length,
          0
        );
        console.log(`  ${ok('FOUND')} ${url}`);
        console.log(
          dim(
            `        ${res.json.info?.title || '?'} ` +
              `${String(res.json.info?.version || '?').replace(/^v?/i, 'v')} — ${count} operations`
          )
        );
        const sec = res.json.securityDefinitions || res.json.components?.securitySchemes;
        if (sec) {
          console.log(dim(`        security schemes: ${JSON.stringify(sec)}`));
        }
        // Surface anything that looks like a login route.
        const loginish = Object.keys(res.json.paths || {}).filter((p) =>
          /login|auth|token|session/i.test(p)
        );
        if (loginish.length) {
          console.log(dim(`        auth-ish paths: ${loginish.join(', ')}`));
        }
        return { url, spec: res.json };
      }
      console.log(`  ${bad(res.status)} ${url}`);
    } catch (err) {
      const cause = err.cause?.code || err.cause?.message || '';
      console.log(`  ${bad('ERR')} ${url} — ${err.message}${cause ? ` (${cause})` : ''}`);
    }
  }
  console.log(
    bad('\n  No spec found.') +
      ' Open the Swagger UI in a browser, look at the network tab for the\n' +
      '  .json request it makes, and set USTORE_SPEC_URL to that URL.'
  );
  return null;
}

async function findLogin(spec) {
  console.log(`\n== 2. Testing the login handshake ==`);
  const { username, password } = config.auth;
  if (!username || !password) {
    console.log(dim('  Skipped — set USTORE_USERNAME and USTORE_PASSWORD to test.'));
    return;
  }

  const paths = new Set([config.auth.loginPath, ...LOGIN_PATHS]);
  if (spec) {
    for (const p of Object.keys(spec.paths || {})) {
      if (/login|auth|token/i.test(p) && spec.paths[p].post) paths.add(p);
    }
  }

  for (const path of paths) {
    for (const shape of BODY_SHAPES) {
      const { label, body } = shape(username, password);
      let res;
      try {
        res = await request(joinUrl(config.baseUrl, path), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (err) {
        continue;
      }
      if (res.status === 404) break; // wrong path, no point trying other shapes
      if (res.ok) {
        console.log(`  ${ok('SUCCESS')} POST ${path}  [${label}]`);
        console.log(dim(`        response: ${res.text.slice(0, 300)}`));
        if (res.json && typeof res.json === 'object') {
          const keys = Object.keys(res.json);
          console.log(dim(`        top-level keys: ${keys.join(', ')}`));
          const tokenKey = keys.find(
            (k) => typeof res.json[k] === 'string' && res.json[k].length > 20
          );
          return {
            path,
            bodyTemplate: shape('{{username}}', '{{password}}').body,
            tokenKey,
            token: tokenKey ? res.json[tokenKey] : null
          };
        }
        return { path, bodyTemplate: shape('{{username}}', '{{password}}').body };
      }
      console.log(dim(`  ${res.status} POST ${path} [${label}]`));
    }
  }
  console.log(
    bad('  No working login found.') +
      ' Check the Swagger UI "Authorize" button — it names the scheme\n' +
      '  the API actually expects.'
  );
  return null;
}

/**
 * The header prefix is the one thing a spec rarely states outright, so try the
 * candidates against a real endpoint instead of guessing. Returns the winner.
 */
async function findScheme(spec, token) {
  console.log(`\n== 3. Testing the Authorization header scheme ==`);
  if (!token) {
    console.log(dim('  Skipped — no token was extracted from the login response.'));
    return null;
  }

  const schemes = spec?.components?.securitySchemes || spec?.securityDefinitions || {};
  let header = 'Authorization';
  const candidates = [];
  for (const [name, def] of Object.entries(schemes)) {
    // An apiKey scheme names the header; the scheme key is often the prefix.
    if (def?.in === 'header' && def?.name) header = def.name;
    if (def?.type === 'apiKey') candidates.push(name);
    if (def?.type === 'http' && def?.scheme) candidates.push(def.scheme.replace(/^\w/, (c) => c.toUpperCase()));
  }
  candidates.push('Bearer', ''); // '' = raw token, no prefix

  // A GET with no required path parameters makes the cheapest probe.
  const probePath = Object.entries(spec?.paths || {})
    .filter(([p, item]) => item.get && !p.includes('{'))
    .map(([p]) => p)
    .sort((a, b) => a.length - b.length)[0];

  if (!probePath) {
    console.log(dim('  Skipped — no parameterless GET endpoint in the spec to test against.'));
    return null;
  }
  console.log(dim(`  Probing GET ${probePath}`));

  for (const scheme of [...new Set(candidates)]) {
    const value = scheme ? `${scheme} ${token}` : token;
    let res;
    try {
      res = await request(joinUrl(config.baseUrl, probePath), {
        headers: { [header]: value, accept: 'application/json' }
      });
    } catch {
      continue;
    }
    const shown = scheme || '(raw, no prefix)';
    if (res.ok) {
      console.log(`  ${ok('WORKS')} ${header}: ${shown} <token>`);
      return { header, scheme };
    }
    console.log(dim(`  ${res.status}   ${header}: ${shown} <token>`));
  }
  console.log(bad('  No scheme worked.') + ' The token may be scoped or short-lived.');
  return null;
}

(async () => {
  console.log(`Target: ${config.baseUrl}`);
  console.log(`TLS verification: ${config.tlsInsecure ? 'DISABLED' : 'enabled'}`);
  const found = await findSpec();
  const login = await findLogin(found?.spec);
  const auth = login ? await findScheme(found?.spec, login.token) : null;

  if (found || login) {
    console.log(`\n== Suggested .env ==\n`);
    if (found) console.log(`    USTORE_SPEC_URL=${found.url}`);
    if (login) {
      console.log(`    USTORE_AUTH_MODE=login`);
      console.log(`    USTORE_LOGIN_PATH=${login.path}`);
      console.log(`    USTORE_LOGIN_BODY=${JSON.stringify(login.bodyTemplate)}`);
      if (login.tokenKey) console.log(`    USTORE_TOKEN_PATH=${login.tokenKey}`);
    }
    if (auth) {
      console.log(`    USTORE_AUTH_HEADER=${auth.header}`);
      console.log(`    USTORE_AUTH_SCHEME=${auth.scheme}`);
    }
  }
  console.log('');
})();
