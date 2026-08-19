import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { config } from './config.js';
import { registerTools } from './tools.js';

function createServer() {
  const server = new McpServer(
    { name: 'ustore-backoffice', version: '1.0.0' },
    {
      instructions:
        'Tools for the XMPie uStore BackOffice REST API. Workflow: ustore_list_tags to see ' +
        'controller groups, ustore_list_endpoints to find an operation, ' +
        'ustore_describe_endpoint to read its contract, then ustore_call_endpoint to run it. ' +
        'Do not guess paths — they come from the live OpenAPI document.'
    }
  );
  registerTools(server);
  return server;
}

/* ------------------------------------------------------------------ stdio */

async function runStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`[ustore-mcp] stdio ready → ${config.baseUrl}`);
}

/* ------------------------------------------------------------------- http */

async function runHttp() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  if (config.bearerGuard) {
    app.use((req, res, next) => {
      if (req.path === '/healthz') return next();
      const hdr = req.get('authorization') || '';
      if (hdr !== `Bearer ${config.bearerGuard}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      next();
    });
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, target: config.baseUrl }));

  // ---- Streamable HTTP (current spec), stateless: one server per request.
  app.all('/mcp', async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[ustore-mcp] /mcp error', err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  // ---- Legacy SSE (matches the existing HAProxy MCP stack).
  const sessions = new Map();

  app.get('/sse', async (req, res) => {
    // Keep intermediaries from buffering the event stream.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    const transport = new SSEServerTransport('/messages', res);
    const server = createServer();
    sessions.set(transport.sessionId, { transport, server });

    res.on('close', () => {
      sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    });

    await server.connect(transport);
    console.error(`[ustore-mcp] SSE session ${transport.sessionId} opened`);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const entry = sessions.get(sessionId);
    if (!entry) {
      return res.status(400).json({ error: `unknown sessionId: ${sessionId}` });
    }
    await entry.transport.handlePostMessage(req, res, req.body);
  });

  app.listen(config.port, config.host, () => {
    console.error(
      `[ustore-mcp] http ready on ${config.host}:${config.port}\n` +
        `  streamable : POST http://${config.host}:${config.port}/mcp\n` +
        `  sse        : GET  http://${config.host}:${config.port}/sse\n` +
        `  target     : ${config.baseUrl}`
    );
  });
}

const mode = config.transport;
if (mode === 'http' || mode === 'sse') {
  runHttp().catch((err) => {
    console.error('[ustore-mcp] fatal', err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error('[ustore-mcp] fatal', err);
    process.exit(1);
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
