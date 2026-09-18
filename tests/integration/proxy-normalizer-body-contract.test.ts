/**
 * Proxy request-BODY normalization CONTRACT — end-to-end regression test.
 *
 * WHY: Per-plugin unit tests already cover the individual normalizers
 * (claude-request-normalizer, codex-request-normalizer, request-sanitizer,
 * kimi-request-normalizer) in isolation. What nothing pinned was the body
 * *as it actually reaches upstream* after the full in-process plugin chain
 * runs. This starts the real CodeMieProxy against a mock upstream that
 * captures and parses the forwarded request body, then asserts the exact
 * transformation each client type produces.
 *
 * Deterministic: authMethod 'jwt' with a DUMMY token (no SSO/keychain/network
 * auth), a mock upstream on an ephemeral port, no gateway key. Each test picks
 * the clientType/model that activates exactly one normalizer.
 *
 * The clientType → active plugin mapping (probed from ALLOWED_* in each plugin):
 *   - request-sanitizer         → codemie-code / codemie-opencode
 *   - claude-request-normalizer → codemie-claude / codemie-copilot / claude-desktop
 *   - kimi-request-normalizer   → codemie-kimi / codemie-kimi-acp
 *   - codex-request-normalizer  → codex-desktop (also fetches the deployment list)
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import type { ProxyConfig } from '../../src/providers/plugins/sso/proxy/proxy-types.js';
import { setupTestIsolation } from '../helpers/test-isolation.js';
import '../../src/providers/plugins/sso/proxy/plugins/index.js'; // register core plugins

const UPSTREAM_TOKEN = 'dummy-upstream-jwt';

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface Harness {
  proxyUrl: string;
  /** The last non-model-listing request the upstream received (body JSON-parsed). */
  lastForwarded: () => CapturedRequest | null;
  /** How many times the /v1/llm_models listing endpoint was hit directly. */
  modelListHits: () => number;
  stop: () => Promise<void>;
}

/**
 * Start a mock upstream + real proxy. `models` (when provided) is served from the
 * `/v1/llm_models` listing endpoint that the codex normalizer fetches directly.
 */
async function startHarness(
  configOverrides: Partial<ProxyConfig> = {},
  models: unknown[] | null = null
): Promise<Harness> {
  let forwarded: CapturedRequest | null = null;
  let listHits = 0;

  const upstream = http.createServer((req, res) => {
    const url = req.url ?? '';

    // Direct deployment-listing fetch made by the codex normalizer.
    if (req.method === 'GET' && url.includes('/v1/llm_models')) {
      listHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models ?? []));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      forwarded = { method: req.method ?? '', url, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const addr = upstream.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const config: ProxyConfig = {
    targetApiUrl: `http://127.0.0.1:${port}`,
    authMethod: 'jwt',
    jwtToken: UPSTREAM_TOKEN,
    provider: 'jwt',
    project: 'test-project',
    version: '9.9.9',
    timeout: 300,
    sessionId: 'sess-normalizer-body',
    ...configOverrides,
  };

  const proxy = new CodeMieProxy(config);
  const { url } = await proxy.start();

  return {
    proxyUrl: url,
    lastForwarded: () => forwarded,
    modelListHits: () => listHits,
    stop: async () => {
      await proxy.stop();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

/** POST a JSON body through the proxy to the given path. */
async function postJson(
  proxyUrl: string,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Proxy request-body normalization contract (end-to-end, in-process)', () => {
  setupTestIsolation();

  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
  });

  describe('request-sanitizer (codemie-code)', () => {
    it('strips reasoning / reasoningSummary / reasoning_summary on chat/completions', async () => {
      harness = await startHarness({ clientType: 'codemie-code', model: 'gpt-5.4' });

      const res = await postJson(harness.proxyUrl, '/v1/chat/completions', {
        model: 'gpt-5.4',
        reasoning: { effort: 'high' },
        reasoningSummary: 'auto',
        reasoning_summary: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // All reasoning-related params are invalid on Chat Completions and dropped.
      expect(body).not.toHaveProperty('reasoning');
      expect(body).not.toHaveProperty('reasoningSummary');
      expect(body).not.toHaveProperty('reasoning_summary');
      // Untouched fields survive.
      expect(body.model).toBe('gpt-5.4');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('preserves reasoning.effort but strips reasoning.summary + camelCase leakage on /responses', async () => {
      harness = await startHarness({ clientType: 'codemie-code', model: 'gpt-5.4' });

      const res = await postJson(harness.proxyUrl, '/v1/responses', {
        model: 'gpt-5.4',
        reasoning: { effort: 'medium', summary: 'auto' },
        reasoningSummary: 'auto',
        input: [],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // reasoning object is kept, but only effort survives inside it.
      expect(body.reasoning).toEqual({ effort: 'medium' });
      expect(body).not.toHaveProperty('reasoningSummary');
    });

    it('does not activate for a non-allowed client type (claude leaves the body untouched)', async () => {
      // claude-request-normalizer only touches thinking/effort/sampling; with a
      // plain gpt model + no such fields, the reasoning params pass straight through.
      harness = await startHarness({ clientType: 'codemie-claude', model: 'gpt-5.4' });

      const res = await postJson(harness.proxyUrl, '/v1/chat/completions', {
        model: 'gpt-5.4',
        reasoningSummary: 'auto',
        messages: [],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // request-sanitizer is scoped out for codemie-claude, so it is NOT stripped.
      expect(body).toHaveProperty('reasoningSummary', 'auto');
    });
  });

  describe('claude-request-normalizer (codemie-claude)', () => {
    it('transforms thinking enabled → adaptive with effort, and strips sampling for claude-sonnet-5', async () => {
      harness = await startHarness({ clientType: 'codemie-claude', model: 'claude-sonnet-5' });

      const res = await postJson(harness.proxyUrl, '/v1/messages', {
        model: 'claude-sonnet-5',
        thinking: { type: 'enabled', budget_tokens: 10000 },
        temperature: 0.7,
        top_p: 0.9,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // enabled → adaptive; budget_tokens 10000 (>8192) maps to effort "high".
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
      // sonnet-5 rejects manual sampling params, so they are stripped.
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
    });

    it('strips the thinking field entirely for a no-thinking model (claude-haiku-4-5)', async () => {
      harness = await startHarness({ clientType: 'codemie-claude', model: 'claude-haiku-4-5' });

      const res = await postJson(harness.proxyUrl, '/v1/messages', {
        model: 'claude-haiku-4-5',
        thinking: { type: 'enabled', budget_tokens: 5000 },
        temperature: 0.4,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // haiku-4-5 has no extended thinking → thinking removed entirely.
      expect(body).not.toHaveProperty('thinking');
      // haiku keeps sampling params (sampling capability = true).
      expect(body.temperature).toBe(0.4);
    });

    it('leaves the body byte-identical when the model has no capability overrides', async () => {
      // A model matching no table row uses DEFAULT_CAPABILITIES (thinking standard,
      // sampling true, effort false) → nothing here needs changing.
      harness = await startHarness({ clientType: 'codemie-claude', model: 'claude-3-5-sonnet' });

      const res = await postJson(harness.proxyUrl, '/v1/messages', {
        model: 'claude-3-5-sonnet',
        temperature: 0.2,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      expect(body.temperature).toBe(0.2);
      expect(body.model).toBe('claude-3-5-sonnet');
      expect(body).not.toHaveProperty('thinking');
    });
  });

  describe('kimi-request-normalizer (codemie-kimi)', () => {
    it('caps oversized output-token fields to 64000 and leaves in-range ones alone', async () => {
      harness = await startHarness({ clientType: 'codemie-kimi', model: 'kimi-k2' });

      const res = await postJson(harness.proxyUrl, '/v1/chat/completions', {
        model: 'kimi-k2',
        max_tokens: 128000,
        max_completion_tokens: 200000,
        maxTokens: 1000, // already under the cap — untouched
        messages: [],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      expect(body.max_tokens).toBe(64000);
      expect(body.max_completion_tokens).toBe(64000);
      expect(body.maxTokens).toBe(1000);
    });
  });

  describe('codex-request-normalizer (codex-desktop)', () => {
    it('maps an undated codex model name to the newest matching dated deployment', async () => {
      harness = await startHarness(
        { clientType: 'codex-desktop' },
        [
          { deployment_name: 'gpt-5-2-2025-06-01', enabled: true },
          { deployment_name: 'gpt-5-2-2026-01-15', enabled: true },
          { deployment_name: 'claude-sonnet-5-2026-02-01', enabled: true }, // not codex-servable
        ]
      );

      const res = await postJson(harness.proxyUrl, '/v1/responses', {
        model: 'gpt-5.2',
        input: [],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // Undated gpt-5.2 resolves to the newest dated deployment of the same identity.
      expect(body.model).toBe('gpt-5-2-2026-01-15');
      // The listing endpoint was fetched directly (not through the proxy).
      expect(harness.modelListHits()).toBeGreaterThanOrEqual(1);
    });

    it('repairs empty tool descriptions in-place using the tool name', async () => {
      harness = await startHarness(
        { clientType: 'codex-desktop' },
        [{ deployment_name: 'gpt-5-2-2026-01-15', enabled: true }]
      );

      const res = await postJson(harness.proxyUrl, '/v1/responses', {
        model: 'gpt-5.2',
        tools: [
          { name: 'search', description: '' },
          { name: 'noop', description: '   ' },
          { name: 'keep', description: 'already set' },
        ],
        input: [],
      });
      expect(res.status).toBe(200);

      const tools = (harness.lastForwarded()?.body as Record<string, unknown>).tools as Array<
        Record<string, unknown>
      >;
      expect(tools[0].description).toBe('search'); // empty → name
      expect(tools[1].description).toBe('noop'); // whitespace-only → name
      expect(tools[2].description).toBe('already set'); // untouched
    });

    it('passes an already-dated exact deployment name through unchanged', async () => {
      harness = await startHarness(
        { clientType: 'codex-desktop' },
        [{ deployment_name: 'gpt-5-2-2026-01-15', enabled: true }]
      );

      const res = await postJson(harness.proxyUrl, '/v1/responses', {
        model: 'gpt-5-2-2026-01-15',
        input: [],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      expect(body.model).toBe('gpt-5-2-2026-01-15');
    });
  });
});
