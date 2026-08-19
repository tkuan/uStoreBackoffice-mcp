# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server exposing the XMPie uStore BackOffice REST API (an internal-network
host) to MCP clients. Node 18.17+, ESM only (`"type": "module"`), no build step,
no test suite, no linter.

## Commands

```bash
npm install
npm run stdio         # stdio transport (Claude Desktop)
npm run http          # HTTP transport on 127.0.0.1:8931
npm run probe         # re-derive the .env auth block from the live API
curl -s localhost:8931/healthz
```

`npm run probe` is the diagnostic to reach for when the API changes: it locates
the spec, brute-forces the login path and body shape, then tests Authorization
header prefixes against a real endpoint and prints the `.env` lines that work.
It confirms rather than guesses, so trust its output over this file.

### Exercising a change

There are no tests. The way to verify end to end is to drive the server as a
real MCP client. Write the script **inside the repo** so `node_modules` resolves:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const t = new StdioClientTransport({
  command: 'node', args: ['index.js'],
  cwd: '/Users/tkuan/Downloads/ustorebackoffice',
  env: { ...process.env, MCP_TRANSPORT: 'stdio' }
});
const c = new Client({ name: 'probe', version: '1' });
await c.connect(t);
console.log((await c.callTool({
  name: 'ustore_call_endpoint',
  arguments: { method: 'GET', path: '/v1/admin/stores', query: { pageSize: 2 } }
})).content[0].text);
await c.close();
```

To reproduce Claude Desktop's environment specifically, pass `cwd: '/'` and
`env: { PATH: process.env.PATH, MCP_TRANSPORT: 'stdio' }` — a bare environment
with no `USTORE_*` vars. Bugs that only appear there are almost always
cwd-relative path assumptions.

## Architecture

The server hardcodes **no endpoints**. It fetches the API's OpenAPI 3.0 document
at startup and projects it into five generic tools, so uStore upgrades surface
new endpoints automatically. Changing what the server can reach means changing
config, not code.

Strict dependency layering, all files flat at the repo root:

```
config.js   env + .env parsing, safety policy      (no internal deps)
http.js     undici fetch wrapper, never throws on HTTP status
auth.js     login handshake + module-level token cache
openapi.js  spec fetch/cache, operation index, $ref deref, schema rendering
tools.js    the five MCP tools; the only place policy is enforced
index.js    transports (stdio | streamable HTTP | legacy SSE)
```

A tool call flows: `tools.js` → `guardPath()` → `openapi.js` (resolve the
operation) → `auth.js` (headers) → `http.js` (send).

### Auth — confirmed against the live API, do not "fix" back to Bearer

```
POST {base}/v1/admin/auth/login   {"email": "...", "password": "..."}
  -> 200 {"Token": "..."}
Authorization: uStoreBackoffice <token>
```

Three non-obvious details, each verified: the login body key is `email` (not
`username`; `username` returns 401 "Email is required"), the response field is
capital-`Token`, and the header scheme is the literal string `uStoreBackoffice`
— a `Bearer` prefix returns 401 "Invalid security token". `USTORE_AUTH_SCHEME`
carries that literal.

`auth.js` caches the token in a module-level variable. With
`USTORE_TOKEN_TTL_SECONDS=0` (the default) it never expires proactively;
instead `ustore_call_endpoint` retries once on 401/403 with `invalidate()` +
`authHeaders({force:true})`. Preserve that retry when touching the call path.

`auth.js` also supports `bearer` / `apikey` / `basic` / `none` modes. They are
unused here — generic fallbacks, not something uStore needs.

### .env resolution is deliberately not cwd-relative

`config.js` calls `dotenv.config()` twice: once for the working directory, then
once for the `.env` beside the module. Precedence is real environment → cwd
`.env` → module-local `.env` (dotenv never overwrites an already-set variable).
This exists because Claude Desktop launches MCP servers with `cwd=/` and a
near-empty environment; a cwd-only lookup silently yields no credentials, which
presents as an authentication error rather than a config error. `ca()` resolves
`USTORE_CA_FILE` against the module directory for the same reason. Do not
reintroduce cwd-relative file lookups.

### Spec loading

`USTORE_SPEC_URL` must be set explicitly for this deployment: it serves OAS3 at
`/ustore-oas3`, and every path in `specCandidates` (`/swagger/v1/swagger.json`
and friends) returns 404. The spec is cached for `USTORE_SPEC_REFRESH_MS`
(15 min default) in a module-level `state` in `openapi.js`; `ustore_server_info
{refreshSpec:true}` forces a reload.

`deref()` inlines `$ref`s with cycle detection and a depth cap of 12;
`renderSchema()` prints a compact shape capped at depth 4. Both degrade
gracefully (`<circular>`, `schemaType()`) rather than throwing — keep that,
since the uStore spec has deeply nested and self-referential models.

### Safety model

Enforced in `guardPath()` ([tools.js](tools.js)), checked before every call:

- `USTORE_ALLOW_WRITES` (default false) — non-GET/HEAD/OPTIONS refused outright.
- `USTORE_DENY_PATHS` — regex denylist, applies even when writes are enabled.
- `USTORE_ALLOW_PATHS` — regex allowlist; when set, nothing else is callable.

BackOffice credentials are full admin, so this is the only thing standing
between a client and destructive operations. Any new tool that reaches the API
must route through `guardPath()`. Responses are truncated at
`USTORE_MAX_RESPONSE_CHARS` (60k); prefer the API's `pageNumber`/`pageSize`
query parameters over raising it.

### Transports

`index.js` branches on `MCP_TRANSPORT`. The `/mcp` streamable endpoint is
**stateless** — a fresh `McpServer` per request, torn down on response close —
while `/sse` keeps a `sessionId → {transport, server}` map. `MCP_BEARER_TOKEN`
guards the HTTP transport itself; it is unrelated to uStore API auth.

## Conventions

- `.env` is gitignored and holds live admin credentials; `.env.example` is the
  tracked template and must stay free of real values.
- `http.js` returns `{ok, status, text, json}` and never throws on status. Tool
  handlers return `text()` / `fail()` helpers, not exceptions.
- Tool output is human-readable text for a model to read, not JSON envelopes.
