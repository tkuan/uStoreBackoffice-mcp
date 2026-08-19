import { z } from 'zod';
import { config, READ_METHODS } from './config.js';
import { authHeaders, invalidate, status as authStatus } from './auth.js';
import { request, joinUrl } from './http.js';
import {
  loadSpec,
  specState,
  findOperation,
  paramList,
  bodySchema,
  responseSchema,
  renderSchema,
  allTags
} from './openapi.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function truncate(s) {
  if (s.length <= config.maxResponseChars) return s;
  return (
    s.slice(0, config.maxResponseChars) +
    `\n\n… [truncated ${s.length - config.maxResponseChars} chars of ${s.length}. ` +
    `Narrow the request with query filters or paging parameters.]`
  );
}

function guardPath(method, path) {
  if (config.allowPaths.length && !config.allowPaths.some((re) => re.test(path))) {
    return `Path "${path}" is not in USTORE_ALLOW_PATHS.`;
  }
  if (config.denyPaths.some((re) => re.test(path))) {
    return `Path "${path}" matches USTORE_DENY_PATHS and is blocked.`;
  }
  if (!READ_METHODS.has(method) && !config.allowWrites) {
    return (
      `Refusing ${method} ${path}: this server is read-only. ` +
      `Set USTORE_ALLOW_WRITES=true on the server to permit mutating calls.`
    );
  }
  return null;
}

/* ------------------------------------------------------------------ tools */

export function registerTools(server) {
  server.registerTool(
    'ustore_list_tags',
    {
      title: 'List uStore API groups',
      description:
        'List the tag groups (controllers) exposed by the uStore BackOffice REST API, ' +
        'with the number of operations in each. Start here to orient yourself.',
      inputSchema: {}
    },
    async () => {
      await loadSpec();
      const { spec, sourceUrl, ops } = specState();
      const lines = allTags().map((t) => `  ${t.tag.padEnd(34)} ${t.count}`);
      return text(
        `${spec.info?.title || 'uStore BackOffice API'} ` +
          `${String(spec.info?.version || '?').replace(/^v?/i, 'v')}\n` +
          `Spec: ${sourceUrl}\n` +
          `Operations: ${ops.length}\n\n` +
          `TAG${' '.repeat(33)}OPS\n${lines.join('\n')}`
      );
    }
  );

  server.registerTool(
    'ustore_list_endpoints',
    {
      title: 'List uStore API endpoints',
      description:
        'List operations in the uStore BackOffice REST API. Filter by tag, HTTP method, ' +
        'or a free-text search across path, operationId and summary.',
      inputSchema: {
        search: z.string().optional().describe('Substring match on path/operationId/summary'),
        tag: z.string().optional().describe('Restrict to one tag group'),
        method: z.string().optional().describe('GET, POST, PUT, DELETE, PATCH'),
        limit: z.number().int().min(1).max(400).optional().describe('Default 100')
      }
    },
    async ({ search, tag, method, limit = 100 }) => {
      await loadSpec();
      const { ops } = specState();
      const q = search?.toLowerCase();
      const m = method?.toUpperCase();

      const hits = ops.filter((o) => {
        if (m && o.method !== m) return false;
        if (tag && !o.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
        if (q) {
          const hay = `${o.path} ${o.operationId} ${o.summary}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      if (!hits.length) return text('No endpoints matched. Try ustore_list_tags first.');

      const shown = hits.slice(0, limit);
      const lines = shown.map((o) => {
        const w = o.deprecated ? ' [DEPRECATED]' : '';
        const rw = READ_METHODS.has(o.method) ? '' : ' [write]';
        return `${o.method.padEnd(6)} ${o.path}${w}${rw}` +
          (o.summary ? `\n         ${o.summary}` : '');
      });

      return text(
        `${hits.length} match${hits.length === 1 ? '' : 'es'}` +
          (shown.length < hits.length ? ` (showing ${shown.length})` : '') +
          `\n\n${lines.join('\n')}`
      );
    }
  );

  server.registerTool(
    'ustore_describe_endpoint',
    {
      title: 'Describe a uStore endpoint',
      description:
        'Show the full contract for one operation: path/query/header parameters, ' +
        'request body shape, and response shape. Call this before ustore_call_endpoint.',
      inputSchema: {
        path: z.string().optional().describe('e.g. /api/Orders/{orderId}'),
        method: z.string().optional().describe('Required when path is ambiguous'),
        operationId: z.string().optional().describe('Alternative to path+method')
      }
    },
    async ({ path, method, operationId }) => {
      await loadSpec();
      const { spec } = specState();
      const op = findOperation({ operationId, method, path });
      if (!op) {
        return fail(
          `No operation found for ${method || ''} ${path || operationId || ''}. ` +
            `Use ustore_list_endpoints to find the exact path.`
        );
      }

      const params = paramList(op, spec);
      const body = bodySchema(op, spec);
      const resp = responseSchema(op, spec);

      const sections = [`${op.method} ${op.path}`];
      if (op.summary) sections.push(op.summary);
      if (op.description && op.description !== op.summary) sections.push(op.description.trim());
      if (op.tags.length) sections.push(`Tags: ${op.tags.join(', ')}`);
      if (op.deprecated) sections.push('*** DEPRECATED ***');

      if (params.length) {
        const rows = params.map(
          (p) =>
            `  ${p.name}${p.required ? '*' : ''} (${p.in}: ${p.type})` +
            (p.default !== undefined ? ` default=${JSON.stringify(p.default)}` : '') +
            (p.description ? `\n      ${p.description}` : '')
        );
        sections.push(`PARAMETERS (* = required)\n${rows.join('\n')}`);
      } else {
        sections.push('PARAMETERS: none');
      }

      if (body) {
        sections.push(
          `REQUEST BODY (${body.contentType}${body.required ? ', required' : ''})\n` +
            renderSchema(body.schema)
        );
      }

      if (resp) {
        sections.push(
          `RESPONSE ${resp.status}` +
            (resp.schema ? `\n${renderSchema(resp.schema)}` : ` — ${resp.description || 'no schema'}`)
        );
      }

      if (!READ_METHODS.has(op.method)) {
        sections.push(
          config.allowWrites
            ? 'NOTE: mutating operation — writes are ENABLED on this server.'
            : 'NOTE: mutating operation — writes are DISABLED; this call will be refused.'
        );
      }

      return text(sections.join('\n\n'));
    }
  );

  server.registerTool(
    'ustore_call_endpoint',
    {
      title: 'Call a uStore endpoint',
      description:
        'Execute a request against the uStore BackOffice REST API. Path placeholders such as ' +
        '{orderId} are filled from pathParams. Authentication is handled by the server. ' +
        'Non-GET methods are refused unless writes are explicitly enabled.',
      inputSchema: {
        method: z.string().describe('GET, POST, PUT, DELETE, PATCH'),
        path: z.string().describe('Spec path, e.g. /api/Orders/{orderId}'),
        pathParams: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe('Values substituted into {placeholders}'),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe('Query string parameters'),
        body: z.any().optional().describe('JSON request body for POST/PUT/PATCH'),
        headers: z.record(z.string()).optional().describe('Extra request headers')
      }
    },
    async ({ method, path, pathParams = {}, query = {}, body, headers = {} }) => {
      const m = String(method).toUpperCase();
      const specPath = path.startsWith('/') ? path : `/${path}`;

      const blocked = guardPath(m, specPath);
      if (blocked) return fail(blocked);

      // Substitute path placeholders.
      let realPath = specPath;
      const missing = [];
      realPath = realPath.replace(/\{([^}]+)\}/g, (_, name) => {
        const v = pathParams[name];
        if (v === undefined || v === null || v === '') {
          missing.push(name);
          return `{${name}}`;
        }
        return encodeURIComponent(String(v));
      });
      if (missing.length) {
        return fail(`Missing pathParams: ${missing.join(', ')}`);
      }

      const url = new URL(joinUrl(config.baseUrl, realPath));
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
        else url.searchParams.set(k, String(v));
      }

      const send = async (force) => {
        const auth = await authHeaders({ force });
        const h = {
          accept: 'application/json',
          ...auth,
          ...headers
        };
        const init = { method: m, headers: h };
        if (body !== undefined && !READ_METHODS.has(m)) {
          h['content-type'] = h['content-type'] || 'application/json';
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        return request(url.toString(), init);
      };

      let res;
      try {
        res = await send(false);
        if ((res.status === 401 || res.status === 403) && config.auth.mode === 'login') {
          invalidate();
          res = await send(true);
        }
      } catch (err) {
        return fail(
          `Request failed: ${err.message}\n` +
            `Check that this host can reach ${config.baseUrl} ` +
            `(the API is internal-network only).`
        );
      }

      const header = `${m} ${url.pathname}${url.search}\nHTTP ${res.status} ${res.statusText}`;
      const payload = res.json !== undefined
        ? JSON.stringify(res.json, null, 2)
        : res.text || '(empty body)';

      if (!res.ok) {
        return fail(truncate(`${header}\n\n${payload}`));
      }
      return text(truncate(`${header}\n\n${payload}`));
    }
  );

  server.registerTool(
    'ustore_server_info',
    {
      title: 'uStore MCP server diagnostics',
      description:
        'Report the configured base URL, spec source, auth mode, and write policy. ' +
        'Use this when calls are failing to confirm how the server is wired up.',
      inputSchema: {
        refreshSpec: z.boolean().optional().describe('Re-fetch the OpenAPI document')
      }
    },
    async ({ refreshSpec = false }) => {
      const lines = [
        `Base URL:      ${config.baseUrl}`,
        `Auth:          ${JSON.stringify(authStatus())}`,
        `Writes:        ${config.allowWrites ? 'ENABLED' : 'disabled (read-only)'}`,
        `Deny paths:    ${config.denyPaths.map((r) => r.source).join(', ') || '(none)'}`,
        `Allow paths:   ${config.allowPaths.map((r) => r.source).join(', ') || '(all)'}`,
        `TLS verify:    ${config.tlsInsecure ? 'DISABLED' : 'enabled'}`,
        `Timeout:       ${config.requestTimeoutMs} ms`,
        `Max resp:      ${config.maxResponseChars} chars`
      ];
      try {
        await loadSpec({ force: refreshSpec });
        const { spec, ops, sourceUrl, loadedAt } = specState();
        lines.push(
          `Spec URL:      ${sourceUrl}`,
          `Spec title:    ${spec.info?.title} ${String(spec.info?.version ?? '').replace(/^v?/i, 'v')}`,
          `Operations:    ${ops.length}`,
          `Spec loaded:   ${new Date(loadedAt).toISOString()}`
        );
      } catch (err) {
        lines.push(`Spec:          FAILED — ${err.message}`);
      }
      return text(lines.join('\n'));
    }
  );
}
