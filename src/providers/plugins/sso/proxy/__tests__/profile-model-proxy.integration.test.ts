/**
 * Profile-model proxy transport integration tests
 * @group unit
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeMieProxy } from '../sso.proxy.js';
import { GatewayKeyPlugin } from '../plugins/gateway-key.plugin.js';
import { HeaderInjectionPlugin } from '../plugins/header-injection.plugin.js';
import { ProfileModelOverridePlugin } from '../plugins/profile-model-override.plugin.js';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';

const GATEWAY_KEY = 'test-local-key';
const PROFILE_MODEL = 'profile-model-id';

interface StartedServer {
  server: Server;
  url: string;
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

async function listen(server: Server): Promise<StartedServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

async function startCapturingUpstream(
  captured: CapturedRequest[]
): Promise<StartedServer> {
  return listen(createServer((req, res) => {
    void (async () => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: await readRequestBody(req),
      });
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    })();
  }));
}

async function startProxy(
  targetApiUrl: string,
  enforceProfileModel = true
): Promise<{ proxy: CodeMieProxy; url: string }> {
  const registry = getPluginRegistry();
  registry.register(new GatewayKeyPlugin());
  registry.register(new ProfileModelOverridePlugin());
  registry.register(new HeaderInjectionPlugin());

  const proxy = new CodeMieProxy({
    targetApiUrl,
    host: '127.0.0.1',
    port: 0,
    provider: 'test-provider',
    gatewayKey: GATEWAY_KEY,
    model: PROFILE_MODEL,
    enforceProfileModel,
    clientType: 'vscode-byok',
  });
  const { url } = await proxy.start();
  return { proxy, url };
}

function authenticatedJsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

describe('profile-model proxy integration', () => {
  const proxies: CodeMieProxy[] = [];
  const servers: Server[] = [];
  const proxyEnvironment = new Map<string, string | undefined>();

  beforeEach(() => {
    resetPluginRegistry();
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      proxyEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const server of servers.splice(0)) await closeServer(server);
    for (const [key, value] of proxyEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    proxyEnvironment.clear();
    resetPluginRegistry();
  });

  it.each([
    ['/v1/responses', {
      model: 'codemie-profile-default',
      input: 'Hello',
      tools: [{ type: 'function', name: 'read_file' }],
      stream: false,
    }],
    ['/v1/chat/completions', {
      model: 'codemie-profile-default',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hello' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', parameters: { type: 'object' } },
      }],
      tool_choice: 'auto',
      stream: false,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 1000,
    }],
  ])('rewrites only the model for %s', async (path, body) => {
    const captured: CapturedRequest[] = [];
    const upstream = await startCapturingUpstream(captured);
    servers.push(upstream.server);
    const startedProxy = await startProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const response = await fetch(`${startedProxy.url}${path}`, authenticatedJsonInit(body));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(path);
    expect(captured[0].body).toEqual({ ...body, model: PROFILE_MODEL });
    expect(captured[0].headers.authorization).toBeUndefined();
    expect(captured[0].headers['x-codemie-client']).toBe('vscode-byok');
  });

  it('forwards SSE bytes incrementally and unchanged', async () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"B"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    let upstreamClosed = false;
    const upstream = await listen(createServer((req, res) => {
      void readRequestBody(req).then(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write(chunks[0]);
        setTimeout(() => {
          res.write(chunks[1]);
          res.end(chunks[2], () => { upstreamClosed = true; });
        }, 30);
      });
    }));
    servers.push(upstream.server);
    const startedProxy = await startProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const response = await fetch(
      `${startedProxy.url}/v1/chat/completions`,
      authenticatedJsonInit({ model: 'logical', messages: [], stream: true })
    );
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(upstreamClosed).toBe(false);
    const received = [Buffer.from(first.value ?? []).toString('utf-8')];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received.push(Buffer.from(next.value).toString('utf-8'));
    }

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(received.join('')).toBe(chunks.join(''));
  });

  it('forwards tool-call response fields unchanged', async () => {
    const toolCall = {
      id: 'completion-1',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'get_test_value', arguments: '{"name":"value"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const upstream = await listen(createServer((req, res) => {
      void readRequestBody(req).then(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(toolCall));
      });
    }));
    servers.push(upstream.server);
    const startedProxy = await startProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const response = await fetch(
      `${startedProxy.url}/v1/chat/completions`,
      authenticatedJsonInit({ model: 'logical', messages: [] })
    );

    expect(await response.json()).toEqual(toolCall);
  });

  it.each([undefined, 'Bearer wrong-key'])(
    'rejects invalid local authorization without reaching upstream', async (authorization) => {
      let upstreamRequests = 0;
      const upstream = await listen(createServer((_req, res) => {
        upstreamRequests++;
        res.end('{}');
      }));
      servers.push(upstream.server);
      const startedProxy = await startProxy(upstream.url);
      proxies.push(startedProxy.proxy);

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authorization) headers.authorization = authorization;
      const response = await fetch(`${startedProxy.url}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'logical', input: 'Hello' }),
      });

      expect(response.status).toBe(401);
      expect(upstreamRequests).toBe(0);
    });

  it('keeps health unauthenticated', async () => {
    const upstream = await listen(createServer((_req, res) => res.end('{}')));
    servers.push(upstream.server);
    const startedProxy = await startProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const response = await fetch(`${startedProxy.url}/health`);

    expect(response.status).toBe(200);
  });

  it('preserves caller-selected model in transparent mode', async () => {
    const captured: CapturedRequest[] = [];
    const upstream = await startCapturingUpstream(captured);
    servers.push(upstream.server);
    const startedProxy = await startProxy(upstream.url, false);
    proxies.push(startedProxy.proxy);

    await fetch(
      `${startedProxy.url}/v1/responses?trace=test`,
      authenticatedJsonInit({ model: 'caller-selected-model', input: 'Hello' })
    );

    expect(captured[0].body.model).toBe('caller-selected-model');
    expect(captured[0].url).toBe('/v1/responses?trace=test');
  });
});
