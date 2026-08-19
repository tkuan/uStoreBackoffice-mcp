import { Agent } from 'undici';
import { config, ca } from './config.js';

const caCert = ca();

export const dispatcher = new Agent({
  connect: {
    rejectUnauthorized: !config.tlsInsecure,
    ...(caCert ? { ca: caCert } : {})
  },
  headersTimeout: config.requestTimeoutMs,
  bodyTimeout: config.requestTimeoutMs
});

/**
 * Thin fetch wrapper that applies the shared dispatcher and a timeout.
 * Returns { status, headers, text, json } — never throws on HTTP status.
 */
export async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      dispatcher,
      signal: controller.signal,
      redirect: options.redirect ?? 'follow'
    });

    const text = await res.text();
    let json;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {
        /* leave undefined */
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      contentType: ct,
      text,
      json
    };
  } finally {
    clearTimeout(timer);
  }
}

export function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}
