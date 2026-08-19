import yaml from 'js-yaml';
import { config } from './config.js';
import { authHeaders } from './auth.js';
import { request, joinUrl } from './http.js';

let state = { spec: null, ops: [], loadedAt: 0, sourceUrl: null };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/* ------------------------------------------------------------------ load */

async function fetchSpec(url) {
  let headers = { accept: 'application/json, text/yaml, */*' };
  try {
    headers = { ...headers, ...(await authHeaders()) };
  } catch {
    // Spec is often anonymous; try without auth.
  }
  const res = await request(url, { headers });
  if (!res.ok) return null;
  if (res.json) return res.json;
  try {
    const doc = yaml.load(res.text);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

export async function loadSpec({ force = false } = {}) {
  const fresh = Date.now() - state.loadedAt < config.specRefreshMs;
  if (state.spec && fresh && !force) return state;

  const candidates = config.specUrl
    ? [config.specUrl]
    : config.specCandidates.map((p) => joinUrl(config.baseUrl, p));

  const tried = [];
  for (const url of candidates) {
    tried.push(url);
    let doc = null;
    try {
      doc = await fetchSpec(url);
    } catch (err) {
      continue;
    }
    if (doc && (doc.paths || doc.swagger || doc.openapi)) {
      state = {
        spec: doc,
        ops: indexOperations(doc),
        loadedAt: Date.now(),
        sourceUrl: url
      };
      return state;
    }
  }

  throw new Error(
    `Could not load an OpenAPI/Swagger document. Tried:\n  ${tried.join('\n  ')}\n` +
      `Set USTORE_SPEC_URL to the exact JSON URL (open the Swagger UI, ` +
      `check the network tab or the "spec" link under the title).`
  );
}

export function specState() {
  return state;
}

/* --------------------------------------------------------------- resolve */

export function resolveRef(ref, spec, seen = new Set()) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  if (seen.has(ref)) return { $circular: ref };
  seen.add(ref);
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = spec;
  for (const p of parts) {
    if (!node || typeof node !== 'object') return null;
    node = node[p];
  }
  return node ?? null;
}

function deref(node, spec, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return node;
  if (node.$ref) {
    const target = resolveRef(node.$ref, spec, seen);
    if (!target) return { unresolved: node.$ref };
    if (target.$circular) return { $ref: node.$ref, note: 'circular' };
    return deref({ ...target, ...(node.description ? { description: node.description } : {}) }, spec, new Set(seen), depth + 1);
  }
  if (Array.isArray(node)) return node.map((n) => deref(n, spec, seen, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = v && typeof v === 'object' ? deref(v, spec, seen, depth + 1) : v;
  }
  return out;
}

/* ----------------------------------------------------------------- index */

function indexOperations(spec) {
  const ops = [];
  const paths = spec.paths || {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    const shared = item.parameters || [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      ops.push({
        operationId: op.operationId || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary || op.description?.split('\n')[0] || '',
        description: op.description || '',
        tags: op.tags || [],
        deprecated: Boolean(op.deprecated),
        rawParameters: [...shared, ...(op.parameters || [])],
        requestBody: op.requestBody || null,
        consumes: op.consumes || spec.consumes || null,
        responses: op.responses || {}
      });
    }
  }
  ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return ops;
}

export function findOperation({ operationId, method, path }) {
  const { ops } = state;
  if (operationId) {
    const exact = ops.find((o) => o.operationId === operationId);
    if (exact) return exact;
    const ci = ops.find(
      (o) => o.operationId.toLowerCase() === String(operationId).toLowerCase()
    );
    if (ci) return ci;
  }
  if (path) {
    const wanted = String(path).startsWith('/') ? path : `/${path}`;
    const m = method ? String(method).toUpperCase() : null;
    const hit = ops.find(
      (o) => o.path.toLowerCase() === wanted.toLowerCase() && (!m || o.method === m)
    );
    if (hit) return hit;
  }
  return null;
}

/* --------------------------------------------------------- presentation */

export function paramList(op, spec) {
  const out = [];
  for (const raw of op.rawParameters) {
    const p = deref(raw, spec);
    if (!p || !p.name) continue;
    const schema = p.schema ? deref(p.schema, spec) : p;
    out.push({
      name: p.name,
      in: p.in,
      required: Boolean(p.required),
      type: schemaType(schema),
      enum: schema?.enum,
      default: schema?.default,
      description: p.description || ''
    });
  }
  return out;
}

export function bodySchema(op, spec) {
  if (op.requestBody) {
    const rb = deref(op.requestBody, spec);
    const content = rb.content || {};
    const key =
      Object.keys(content).find((k) => k.includes('json')) || Object.keys(content)[0];
    if (!key) return null;
    return {
      contentType: key,
      required: Boolean(rb.required),
      schema: deref(content[key].schema, spec)
    };
  }
  // Swagger 2.0 body parameter
  const bodyParam = op.rawParameters
    .map((p) => deref(p, spec))
    .find((p) => p && p.in === 'body');
  if (bodyParam) {
    return {
      contentType: (op.consumes && op.consumes[0]) || 'application/json',
      required: Boolean(bodyParam.required),
      schema: deref(bodyParam.schema, spec)
    };
  }
  return null;
}

export function responseSchema(op, spec) {
  const codes = Object.keys(op.responses || {});
  const ok = codes.find((c) => /^2/.test(c)) || codes[0];
  if (!ok) return null;
  const r = deref(op.responses[ok], spec);
  if (r.schema) return { status: ok, schema: r.schema };
  const content = r.content || {};
  const key =
    Object.keys(content).find((k) => k.includes('json')) || Object.keys(content)[0];
  if (!key) return { status: ok, schema: null, description: r.description };
  return { status: ok, contentType: key, schema: deref(content[key].schema, spec) };
}

function schemaType(s) {
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.$ref) return s.$ref.split('/').pop();
  if (s.type === 'array') return `${schemaType(s.items)}[]`;
  if (s.enum) return `enum(${s.enum.slice(0, 8).join('|')})`;
  return s.format ? `${s.type}<${s.format}>` : s.type || (s.properties ? 'object' : 'unknown');
}

/** Renders a JSON schema as a compact, depth-limited shape. */
export function renderSchema(schema, depth = 0, maxDepth = 4) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.note === 'circular' || schema.$circular) return '<circular>';
  if (depth >= maxDepth) return schemaType(schema);

  const pad = '  '.repeat(depth + 1);

  if (schema.allOf) {
    const merged = schema.allOf.reduce(
      (acc, s) => ({
        ...acc,
        ...s,
        properties: { ...(acc.properties || {}), ...(s.properties || {}) },
        required: [...(acc.required || []), ...(s.required || [])]
      }),
      {}
    );
    return renderSchema(merged, depth, maxDepth);
  }
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf;
    return variants.map((v) => renderSchema(v, depth, maxDepth)).join(' | ');
  }
  if (schema.type === 'array' || schema.items) {
    return `${renderSchema(schema.items, depth, maxDepth)}[]`;
  }
  if (schema.properties) {
    const req = new Set(schema.required || []);
    const lines = Object.entries(schema.properties).map(([k, v]) => {
      const flag = req.has(k) ? '*' : '';
      const desc = v?.description ? `  // ${String(v.description).slice(0, 90)}` : '';
      return `${pad}${k}${flag}: ${renderSchema(v, depth + 1, maxDepth)}${desc}`;
    });
    return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
  }
  return schemaType(schema);
}

export function allTags() {
  const counts = new Map();
  for (const op of state.ops) {
    const tags = op.tags.length ? op.tags : ['(untagged)'];
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}
