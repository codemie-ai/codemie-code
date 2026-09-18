/**
 * Proxy header CONTRACT — EXTENDED regression test.
 *
 * WHY: proxy-header-contract.test.ts pins the UNCONDITIONAL X-CodeMie-* headers
 * (CLI version, client, project, request/session id, gateway-key strip → auth
 * inject) plus the litellm-session-id toggle. It does NOT cover the CONDITIONAL
 * headers in HeaderInjectionPlugin: X-CodeMie-Repository / X-CodeMie-Branch
 * (only when config.repository/branch set), X-CodeMie-Integration (only when the
 * provider is marked requiresIntegration AND config.integrationId is set),
 * X-CodeMie-CLI-Model / X-CodeMie-CLI-Timeout (only when configured), and the
 * exact X-CodeMie-Session-ID value. This file pins THAT contract end-to-end
 * against a header-capturing mock upstream, so a change to when the proxy adds,
 * drops, or gates any of these headers breaks a test — which is the point.
 *
 * Deterministic: authMethod 'jwt' with a DUMMY token (no SSO/keychain/network),
 * a mock upstream on an ephemeral port, and a fixed gateway key. A dedicated
 * test provider registered into ProviderRegistry supplies the
 * `requiresIntegration` custom property so we can exercise the integration gate
 * without depending on any real provider's metadata.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import http from 'node:http';
import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import type { ProxyConfig } from '../../src/providers/plugins/sso/proxy/proxy-types.js';
import { ProviderRegistry } from '../../src/providers/core/registry.js';
import type { ProviderTemplate } from '../../src/providers/core/types.js';
import '../../src/providers/plugins/sso/proxy/plugins/index.js'; // register core plugins

const GATEWAY_KEY = 'gw-secret-key';
const UPSTREAM_TOKEN = 'dummy-upstream-jwt';

// Unique provider names so this file never collides with real providers or
// other test files that share the process-wide ProviderRegistry singleton.
const REQ_INT_PROVIDER = 'test-ext-req-int-provider';
const NO_INT_PROVIDER = 'test-ext-no-int-provider';

interface Harness {
  proxyUrl: string;
  captured: () => http.IncomingHttpHeaders;
  hits: () => number;
  stop: () => Promise<void>;
}

/**
 * Start a proxy + header-capturing mock upstream. Unlike the base test's
 * harness, this sets ONLY the fields explicitly provided so we can observe the
 * "field absent" branches. `provider` defaults to 'jwt' (a provider that is NOT
 * requiresIntegration) so the integration gate stays closed by default.
 */
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
    clientType: 'codemie-codex',
    version: '9.9.9',
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

/** POST through the proxy. `auth` omitted → no Authorization header at all. */
function callProxy(proxyUrl: string, auth?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== undefined) headers.Authorization = auth;
  return fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ hello: 'world' }),
  });
}

function makeProvider(name: string, requiresIntegration: boolean): ProviderTemplate {
  return {
    name,
    displayName: name,
    description: 'test provider',
    defaultBaseUrl: 'http://127.0.0.1',
    recommendedModels: [],
    capabilities: [],
    supportsModelInstallation: false,
    customProperties: { requiresIntegration },
  };
}

describe('Proxy header contract — conditional headers (end-to-end, in-process)', () => {
  let harness: Harness | undefined;

  beforeAll(() => {
    // A provider that requires an integration header, and one that does not.
    ProviderRegistry.registerProvider(makeProvider(REQ_INT_PROVIDER, true));
    ProviderRegistry.registerProvider(makeProvider(NO_INT_PROVIDER, false));
  });

  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
  });

  it('sets X-CodeMie-Repository and X-CodeMie-Branch when configured', async () => {
    harness = await startHarness({ repository: 'org/repo', branch: 'feature/x' });
    const res = await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(res.status).toBe(200);

    const h = harness.captured();
    expect(h['x-codemie-repository']).toBe('org/repo');
    expect(h['x-codemie-branch']).toBe('feature/x');
  });

  it('OMITS X-CodeMie-Repository and X-CodeMie-Branch when not configured', async () => {
    harness = await startHarness();
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);

    const h = harness.captured();
    expect(h['x-codemie-repository']).toBeUndefined();
    expect(h['x-codemie-branch']).toBeUndefined();
  });

  it('sets X-CodeMie-Integration only when provider requiresIntegration AND integrationId is present', async () => {
    harness = await startHarness({ provider: REQ_INT_PROVIDER, integrationId: 'int-42' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-integration']).toBe('int-42');
  });

  it('OMITS X-CodeMie-Integration when provider requiresIntegration but integrationId is missing', async () => {
    harness = await startHarness({ provider: REQ_INT_PROVIDER });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-integration']).toBeUndefined();
  });

  it('OMITS X-CodeMie-Integration when integrationId is present but provider does NOT require integration', async () => {
    harness = await startHarness({ provider: NO_INT_PROVIDER, integrationId: 'int-99' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-integration']).toBeUndefined();
  });

  it('OMITS X-CodeMie-Integration for an unknown/normal provider even with integrationId', async () => {
    // 'jwt' is not registered as a requiresIntegration provider (getProvider
    // may even return undefined) — the gate must stay closed.
    harness = await startHarness({ provider: 'jwt', integrationId: 'int-77' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-integration']).toBeUndefined();
  });

  it('OMITS X-CodeMie-CLI-Model when no model is configured', async () => {
    harness = await startHarness();
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-cli-model']).toBeUndefined();
  });

  it('sets X-CodeMie-CLI-Model when a model is configured', async () => {
    harness = await startHarness({ model: 'gpt-5.4' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-cli-model']).toBe('gpt-5.4');
  });

  it('OMITS X-CodeMie-CLI-Timeout when no timeout is configured', async () => {
    harness = await startHarness();
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-cli-timeout']).toBeUndefined();
  });

  it('sets X-CodeMie-CLI-Timeout as a stringified number when configured', async () => {
    harness = await startHarness({ timeout: 120 });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-cli-timeout']).toBe('120');
  });

  it('sets X-CodeMie-Session-ID equal to config.sessionId when provided', async () => {
    harness = await startHarness({ sessionId: 'sess-xyz-789' });
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    expect(harness.captured()['x-codemie-session-id']).toBe('sess-xyz-789');
  });

  it('OMITS X-CodeMie-Session-ID when config.sessionId is absent (no "unknown" sentinel forwarded)', async () => {
    harness = await startHarness();
    await callProxy(harness.proxyUrl, `Bearer ${GATEWAY_KEY}`);
    // The header is dropped entirely rather than forwarding the 'unknown' fallback
    // that context.sessionId defaults to.
    expect(harness.captured()['x-codemie-session-id']).toBeUndefined();
  });

  it('rejects a request with NO Authorization header (missing gateway key) with 401 and never calls upstream', async () => {
    harness = await startHarness();
    const res = await callProxy(harness.proxyUrl); // no Authorization at all
    expect(res.status).toBe(401);
    expect(harness.hits()).toBe(0);
  });
});
