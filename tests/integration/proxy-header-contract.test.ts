/**
 * Proxy header CONTRACT — end-to-end regression test.
 *
 * WHY: HeaderInjectionPlugin (X-CodeMie-* headers) had NO test at all, and
 * nothing asserted what *actually reaches upstream* after the full plugin chain
 * runs (gateway-key strip → auth inject → header inject). So a change to which
 * headers the proxy adds, renames, drops, or forwards would ship silently. This
 * pins that contract: it runs the real CodeMieProxy in-process against a mock
 * upstream that captures the exact headers it receives.
 *
 * Deterministic: authMethod 'jwt' with a DUMMY token (no SSO/keychain/network),
 * a mock upstream, and a fixed gateway key. If any header behavior changes,
 * these assertions break — which is the point.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import type { ProxyConfig } from '../../src/providers/plugins/sso/proxy/proxy-types.js';
import '../../src/providers/plugins/sso/proxy/plugins/index.js'; // register core plugins

const GATEWAY_KEY = 'gw-secret-key';
const UPSTREAM_TOKEN = 'dummy-upstream-jwt';

interface Harness {
  proxyUrl: string;
  /** Headers the mock upstream last received (lowercased by Node). */
  captured: () => http.IncomingHttpHeaders;
  /** How many times the mock upstream was hit. */
  hits: () => number;
  stop: () => Promise<void>;
}

async function startHarness(configOverrides: Partial<ProxyConfig> = {}): Promise<Harness> {
  let lastHeaders: http.IncomingHttpHeaders = {};
  let count = 0;

  const upstream = http.createServer((req, res) => {
    count += 1;
    lastHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const addr = upstream.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const config: ProxyConfig = {
    targetApiUrl: `http://127.0.0.1:${port}`,
    authMethod: 'jwt',
    jwtToken: UPSTREAM_TOKEN,
    gatewayKey: GATEWAY_KEY,
    provider: 'jwt',
    model: 'gpt-5.4',
    clientType: 'codemie-codex',
    project: 'test-project',
    version: '9.9.9',
    timeout: 300,
    sessionId: 'sess-abc-123',
    ...configOverrides,
  };
  const proxy = new CodeMieProxy(config);
  const { url } = await proxy.start();

  return {
    proxyUrl: url,
    captured: () => lastHeaders,
    hits: () => count,
    stop: async () => {
      await proxy.stop();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

/** POST through the proxy with a given incoming Authorization header. */
function callProxy(proxyUrl: string, auth: string): Promise<Response> {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ hello: 'world' }),
  });
}

describe('Proxy header contract (end-to-end, in-process)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
  });

  it('strips the gateway key and injects the real upstream auth + all X-CodeMie-* headers', async () => {
    harness = await startHarness();

    const res = await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(res.status).toBe(200);
    expect(harness.hits()).toBe(1);

    const h = harness.captured();
    // Gateway key is stripped and replaced by the real upstream token — the
    // local gateway secret must NEVER be forwarded upstream.
    expect(h['authorization']).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(h['authorization']).not.toContain(GATEWAY_KEY);

    // CodeMie identity/context headers.
    expect(h['x-codemie-cli']).toBe('codemie-cli/9.9.9');
    expect(h['x-codemie-cli-model']).toBe('gpt-5.4');
    expect(h['x-codemie-client']).toBe('codemie-codex');
    expect(h['x-codemie-project']).toBe('test-project');
    expect(h['x-codemie-cli-timeout']).toBe('300');
    expect(h['x-codemie-session-id']).toBeTruthy();
    expect(h['x-codemie-request-id']).toBeTruthy();
  });

  it('adds x-litellm-session-id for codex client type', async () => {
    harness = await startHarness({ clientType: 'codemie-codex' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-litellm-session-id']).toBeTruthy();
  });

  it('omits x-litellm-session-id for the daemon client type', async () => {
    harness = await startHarness({ clientType: 'codemie-daemon' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-litellm-session-id']).toBeUndefined();
  });

  it('rejects a wrong gateway key with 401 and never calls upstream', async () => {
    harness = await startHarness();
    const res = await callProxy(harness.proxyUrl, 'Bearer wrong-key');
    expect(res.status).toBe(401);
    expect(harness.hits()).toBe(0);
  });
});
