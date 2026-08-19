# ustore-backoffice-mcp

An MCP server for the XMPie uStore BackOffice REST API at
`https://produproduce.mysite.com/ustorebackofficerestapi`.

**Status: working, verified end to end against the live API.** The spec loads
(52 paths / 63 operations across 15 tag groups), login succeeds, and
`ustore_call_endpoint GET /v1/admin/stores` returns HTTP 200. The read-only
guard correctly refuses `DELETE`.

## Design

The server does **not** hardcode endpoints. On first use it fetches the API's own
OpenAPI 3.0 document and exposes five tools over it:

| Tool | Purpose |
|---|---|
| `ustore_list_tags` | Controller groups + operation counts — the orientation call |
| `ustore_list_endpoints` | Search/filter operations by tag, method, or text |
| `ustore_describe_endpoint` | Full contract: params, request body, response shape |
| `ustore_call_endpoint` | Execute a request; auth handled server-side |
| `ustore_server_info` | Diagnostics: base URL, spec source, auth mode, write policy |

This is the same shape as the MSSQL MCP servers (`list_databases` →
`list_tables` → `describe_table` → `query`), and it keeps the tool count low
regardless of how many endpoints the API exposes. It also survives uStore
upgrades — new endpoints appear automatically on the next spec refresh.

Writes are **disabled by default**. Non-GET methods are refused until
`USTORE_ALLOW_WRITES=true` is set on the server process.

## Setup

Must run on a host with internal network access to `produproduce`.

```bash
cd /opt/mcp/ustore-backoffice-mcp
npm install
cp .env.example .env
$EDITOR .env          # credentials — the base URL and spec URL are preset
npm run probe         # optional: re-confirm the spec URL and auth handshake
```

The auth handshake is confirmed against the live API and is already the default:

```
POST {base}/v1/admin/auth/login   {"email": "...", "password": "..."}
  -> 200 {"Token": "..."}

Authorization: uStoreBackoffice <token>     # on every subsequent request
```

Note the login body uses `email`, not `username`, and the token field is
capital-`Token`. The scheme is literally `uStoreBackoffice` — the API rejects any
other prefix with `{"Errors":[{"Message":"Invalid security token."}]}`.

The spec URL is likewise confirmed and preset:

```
USTORE_SPEC_URL=https://produproduce.mysite.com/ustorebackofficerestapi/ustore-oas3
```

It must be set explicitly — this deployment serves OAS3 at `/ustore-oas3`, and
the paths `loadSpec()` would otherwise probe all return 404.

Then:

```bash
npm run http          # or: npm run stdio
```

Verify:

```bash
$ curl -s localhost:8931/healthz
{"ok":true,"target":"https://produproduce.mysite.com/ustorebackofficerestapi"}
```

`/healthz` only proves the process is up. To confirm the API leg works, call
`ustore_server_info` from a client — it reports the resolved auth scheme and the
operation count, and it fails loudly if login is broken.

## Deployment

### pm2

```bash
pm2 start index.js --name ustore-mcp --node-args="--enable-source-maps"
pm2 save
```

### systemd

```ini
[Unit]
Description=uStore BackOffice MCP server
After=network-online.target

[Service]
Type=simple
User=tc
WorkingDirectory=/opt/mcp/ustore-backoffice-mcp
EnvironmentFile=/opt/mcp/ustore-backoffice-mcp/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Keep `.env` at `chmod 600` — it holds a uStore BackOffice credential, which is
an administrative one.

### HAProxy

SSE needs buffering off and a long server timeout, or sessions get cut:

```
backend be_mcp_ustore
    mode http
    option http-server-close
    timeout server 3600s
    timeout tunnel 3600s
    http-request set-header X-Accel-Buffering no
    server ustore1 127.0.0.1:8931 check
```

Both transports are served: `POST /mcp` (Streamable HTTP, current spec) and
`GET /sse` + `POST /messages` (legacy SSE, matching the existing stack). Set
`MCP_BEARER_TOKEN` if you want the server itself to check a shared secret rather
than relying on HAProxy ACLs alone.

## Client config

Local stdio (Claude Desktop on the same box):

```json
{
  "mcpServers": {
    "ustore-backoffice": {
      "command": "node",
      "args": ["/opt/mcp/ustore-backoffice-mcp/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

Write the config file as UTF-8 **without** a BOM.

No credentials are needed in that `env` block: the server reads the `.env` that
sits next to `index.js`. Claude Desktop launches MCP servers with `cwd=/` and a
near-empty environment, so `config.js` resolves `.env` against its own file
location rather than the working directory. Anything you *do* put in `env`
still wins — real environment variables take precedence over the file.

After editing the config, **fully quit** Claude Desktop (Cmd-Q on macOS, not just
closing the window) so the server process is relaunched.

## Notes and gotchas

- **Credential scope.** BackOffice API accounts are typically full admin. If
  uStore supports a limited operator role, use one — the read-only guard in this
  server protects against accidents, not against a compromised token.
- **`USTORE_ALLOW_PATHS`** is a regex allowlist. Setting it narrows the server to
  the controllers you actually need, which is a stronger control than the write
  flag alone.
- **Response truncation** defaults to 60k characters. If a listing endpoint
  overflows, use its paging parameters rather than raising the cap — this API
  spells them `pageNumber` (1-based) and `pageSize` (default 50).
- **Spec caching** refreshes every 15 minutes. After a uStore upgrade, call
  `ustore_server_info` with `refreshSpec: true` to pick up changes immediately.
- **Auth failures that look like connection failures.** The server starts and
  lists its tools even when credentials are missing — the login only happens on
  the first API call. If tools appear but every call errors, run
  `ustore_server_info` and check `hasToken`.
- **This complements, not replaces, the SQL MCP server.** The REST API enforces
  uStore's business logic, so it is the right path for anything that mutates
  state. Direct `[PRODUPRODUCE].ustore` queries remain better for reporting joins
  and schema archaeology.
