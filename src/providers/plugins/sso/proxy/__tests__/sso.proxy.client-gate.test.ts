/**
 * The proxy's one client gate: an interceptor that lists clients runs its request hooks only for a request of one of
 * them (`ProxyContext.agentName`, checked when its turn comes); one that lists none runs for every request.
 *
 * Seam: a real CodeMieProxy over a fake upstream on loopback, with stub plugins, or the core plugins.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeMieProxy } from '../sso.proxy.js';
import type { ProxyConfig, ProxyContext } from '../proxy-types.js';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';
import { registerCorePlugins } from '../plugins/index.js';
import { BackgroundRequestNormalizerPlugin } from '../plugins/background-request-normalizer.plugin.js';
import { KimiRequestNormalizerPlugin } from '../plugins/kimi-request-normalizer.plugin.js';
import type { ProxyInterceptor, ProxyPlugin } from '../plugins/types.js';

/** The hooks each probe ran, per client the request had when they ran. */
let ran: Record<string, string[]>;
let proxy: CodeMieProxy | undefined;
let upstream: Server | undefined;
let forwardedBodies: string[];

function record(probe: string, context: ProxyContext, hook: string): void {
  (ran[`${probe}:${context.agentName}`] ??= []).push(hook);
}

/** A plugin whose interceptor records every request hook it runs. */
function probe(id: string, priority: number, clients?: readonly string[]): ProxyPlugin {
  const interceptor: ProxyInterceptor = {
    name: id,
    handleRequest: async (context) => { record(id, context, 'handleRequest'); return false; },
    onRequest: async (context) => record(id, context, 'onRequest'),
    onUpstreamResponse: async (context, response) => { record(id, context, 'onUpstreamResponse'); return response; },
    onResponseHeaders: async (context) => record(id, context, 'onResponseHeaders'),
    onResponseChunk: async (context, chunk) => { record(id, context, 'onResponseChunk'); return chunk; },
    onResponseStreamEnd: async (context) => { record(id, context, 'onResponseStreamEnd'); return null; },
    onResponseComplete: async (context) => record(id, context, 'onResponseComplete'),
    onError: async (context) => record(id, context, 'onError'),
  };
  return { id, name: id, version: '1.0.0', priority, ...(clients && { clients }), createInterceptor: () => interceptor };
}

/** Sets the request's client from `x-test-client`, as the gateway key does from a named key. */
const clientSetter: ProxyPlugin = {
  id: 'client-setter',
  name: 'client-setter',
  version: '1.0.0',
  priority: 1,
  createInterceptor: () => ({
    name: 'client-setter',
    handleRequest: async (context) => {
      if (context.headers['x-test-client']) context.agentName = context.headers['x-test-client'];
      return false;
    },
  }),
};

async function start(config: Partial<ProxyConfig> = {}): Promise<string> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/fail') {
        req.socket.destroy();
        return;
      }
      forwardedBodies.push(Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const server = upstream;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy = new CodeMieProxy({
    targetApiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    host: '127.0.0.1',
    authMethod: 'jwt',
    jwtToken: 'dummy-upstream-jwt',
    provider: 'jwt',
    ...config,
  });
  return (await proxy!.start()).url;
}

async function post(url: string, path: string, client?: string, body = '{"model":"m"}'): Promise<void> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(client && { 'x-test-client': client }) },
    body,
  });
  await response.text();
}

const REQUEST_HOOKS = [
  'handleRequest', 'onRequest', 'onUpstreamResponse', 'onResponseHeaders', 'onResponseChunk', 'onResponseStreamEnd',
  'onResponseComplete',
];

beforeEach(() => {
  resetPluginRegistry();
  ran = {};
  forwardedBodies = [];
});

afterEach(async () => {
  await proxy?.stop();
  const server = upstream;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  proxy = undefined;
  upstream = undefined;
  resetPluginRegistry();
});

describe('the proxy\'s client gate', () => {
  beforeEach(() => {
    const registry = getPluginRegistry();
    registry.register(clientSetter);
    registry.register(probe('gated', 10, ['a']));
    registry.register(probe('open', 20));
  });

  it('runs a gated interceptor\'s request hooks for its client alone, and an open one for every client', async () => {
    // The proxy's own client is `b`: the setter's hook turns the first request into an `a` one before the gated turn
    const url = await start({ clientType: 'b' });

    await post(url, '/v1/messages', 'a');
    await post(url, '/v1/messages');

    expect(ran).toEqual({ 'gated:a': REQUEST_HOOKS, 'open:a': REQUEST_HOOKS, 'open:b': REQUEST_HOOKS });
  });

  it('runs a gated interceptor\'s onError for its client alone', async () => {
    const url = await start({ clientType: 'b' });

    await post(url, '/fail', 'a');
    await post(url, '/fail');

    expect(ran['gated:a']).toContain('onError');
    expect(ran['open:a']).toContain('onError');
    expect(ran['open:b']).toContain('onError');
    expect(ran).not.toHaveProperty('gated:b');
  });
});

describe('the gated core plugins', () => {
  it('edge: a request of no client type (`unknown`) gets no gated plugin and is forwarded unchanged', async () => {
    registerCorePlugins();
    const url = await start();
    const body = JSON.stringify({
      model: 'claude-sonnet-5', thinking: { type: 'enabled', budget_tokens: 10000 }, reasoningSummary: 'auto', max_tokens: 128000,
      input: [{ type: 'reasoning', encrypted_content: 'abc==' }], user: 'x'.repeat(80), messages: [],
    });

    await post(url, '/v1/responses', undefined, body);

    expect(JSON.parse(forwardedBodies[0])).toEqual(JSON.parse(body));
  });

  it('the background normalizer declares exactly the Claude clients', () => {
    expect(new BackgroundRequestNormalizerPlugin().clients)
      .toEqual(['codemie-claude', 'codemie-copilot', 'claude-desktop', 'vscode-claude-code']);
  });

  it('the Kimi normalizer declares exactly the Kimi clients', () => {
    expect(new KimiRequestNormalizerPlugin().clients).toEqual(['codemie-kimi', 'codemie-kimi-acp']);
  });
});
