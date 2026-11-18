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
 * Deterministic: authMethod 'jwt' with a DUMMY token (no keychain/network auth),
 * a mock upstream on an ephemeral port. The wrapper names (codemie-code,
 * codemie-claude, codemie-kimi, ...) run one proxy per clientType with no
 * gateway key; the daemon's client names run through one proxy with a gateway
 * key, the client chosen per request by its key. The money section signs in
 * with an SSO cookie from the file credential store (keytar mocked away).
 *
 * The client → active plugin mapping (the `clients` each plugin declares):
 *   - request-sanitizer         → codemie-code / codemie-opencode
 *   - claude-request-normalizer → codemie-claude / codemie-copilot / claude-desktop / vscode-claude-code
 *   - kimi-request-normalizer   → codemie-kimi / codemie-kimi-acp
 *   - codex-request-normalizer  → codex-desktop (also fetches the deployment list)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The keychain is the boundary: the SSO cookie of the money section lives in the file store under CODEMIE_HOME
vi.mock('keytar', () => {
  throw new Error('no keychain in this test');
});

import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import type { ProxyConfig } from '../../src/providers/plugins/sso/proxy/proxy-types.js';
import { CredentialStore } from '../../src/utils/security.js';
import { setupTestIsolation } from '../helpers/test-isolation.js';
import '../../src/providers/plugins/sso/sso.template.js'; // register the ai-run-sso provider
import '../../src/providers/plugins/sso/proxy/plugins/index.js'; // register core plugins

const UPSTREAM_TOKEN = 'dummy-upstream-jwt';

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

interface Harness {
  proxyUrl: string;
  /** The last non-model-listing request the upstream received (body JSON-parsed). */
  lastForwarded: () => CapturedRequest | null;
  /** Every non-model-listing request the upstream received, in order. */
  allForwarded: () => CapturedRequest[];
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
  models: unknown[] | null = null,
  answer: (req: http.IncomingMessage) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } }),
  /** Runs with the upstream's URL before the proxy starts (e.g. to store a login for it). */
  beforeStart?: (targetApiUrl: string) => Promise<void>
): Promise<Harness> {
  let forwarded: CapturedRequest | null = null;
  const all: CapturedRequest[] = [];
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
      forwarded = { method: req.method ?? '', url, headers: req.headers, body };
      all.push(forwarded);
      const { status, body: answerBody } = answer(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answerBody));
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

  await beforeStart?.(config.targetApiUrl);
  const proxy = new CodeMieProxy(config);
  const { url } = await proxy.start();

  return {
    proxyUrl: url,
    lastForwarded: () => forwarded,
    allForwarded: () => all,
    modelListHits: () => listHits,
    stop: async () => {
      await proxy.stop();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

/** POST a JSON body through the proxy to the given path, with a gateway key when given. */
async function postJson(
  proxyUrl: string,
  path: string,
  body: unknown,
  gatewayKey?: string
): Promise<Response> {
  return fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(gatewayKey && { Authorization: `Bearer ${gatewayKey}` }) },
    body: JSON.stringify(body),
  });
}

const GATEWAY_KEY = 'codemie-proxy';
/** The key a client of the daemon sends: the shared key with its client name. */
const keyOf = (client: string) => `${GATEWAY_KEY}.${client}`;

/** The daemon's proxy: one for every client, a gateway key, the shared key served as `defaultClient`. */
function startDaemonHarness(
  overrides: Partial<ProxyConfig> = {},
  models: unknown[] | null = null,
  answer?: Parameters<typeof startHarness>[2]
): Promise<Harness> {
  return startHarness({ gatewayKey: GATEWAY_KEY, clientType: 'codemie-daemon', ...overrides }, models, answer);
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

    it('transforms thinking enabled → adaptive with effort for claude-opus-5-5', async () => {
      harness = await startHarness({ clientType: 'codemie-claude', model: 'claude-opus-5-5' });

      const res = await postJson(harness.proxyUrl, '/v1/messages', {
        model: 'claude-opus-5-5',
        thinking: { type: 'enabled', budget_tokens: 10000 },
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
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

  describe('codex-request-normalizer (codex-desktop, by its key through the daemon)', () => {
    it('maps an undated codex model name to the newest matching dated deployment', async () => {
      harness = await startDaemonHarness(
        {},
        [
          { deployment_name: 'gpt-5-2-2025-06-01', enabled: true },
          { deployment_name: 'gpt-5-2-2026-01-15', enabled: true },
          { deployment_name: 'claude-sonnet-5-2026-02-01', enabled: true }, // not codex-servable
        ]
      );

      const res = await postJson(harness.proxyUrl, '/v1/responses', {
        model: 'gpt-5.2',
        input: [],
      }, keyOf('codex-desktop'));
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      // Undated gpt-5.2 resolves to the newest dated deployment of the same identity.
      expect(body.model).toBe('gpt-5-2-2026-01-15');
      // The listing endpoint was fetched directly (not through the proxy).
      expect(harness.modelListHits()).toBeGreaterThanOrEqual(1);
    });

    it('repairs empty tool descriptions in-place using the tool name', async () => {
      harness = await startDaemonHarness(
        {},
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
      }, keyOf('codex-desktop'));
      expect(res.status).toBe(200);

      const tools = (harness.lastForwarded()?.body as Record<string, unknown>).tools as Array<
        Record<string, unknown>
      >;
      expect(tools[0].description).toBe('search'); // empty → name
      expect(tools[1].description).toBe('noop'); // whitespace-only → name
      expect(tools[2].description).toBe('already set'); // untouched
    });

    it('passes an already-dated exact deployment name through unchanged', async () => {
      harness = await startDaemonHarness(
        {},
        [{ deployment_name: 'gpt-5-2-2026-01-15', enabled: true }]
      );

      const res = await postJson(harness.proxyUrl, '/v1/responses', {
        model: 'gpt-5-2-2026-01-15',
        input: [],
      }, keyOf('codex-desktop'));
      expect(res.status).toBe(200);

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      expect(body.model).toBe('gpt-5-2-2026-01-15');
    });
  });

  describe('the daemon\'s client names, each by its key through one proxy', () => {
    const THINKING = { model: 'claude-sonnet-5', thinking: { type: 'enabled', budget_tokens: 10000 }, messages: [] };

    it.each(['claude-desktop', 'vscode-claude-code'])('%s: the Claude normalizer turns thinking enabled into adaptive', async (client) => {
      harness = await startDaemonHarness();

      await postJson(harness.proxyUrl, '/v1/messages', THINKING, keyOf(client));

      const body = harness.lastForwarded()?.body as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it.each(['codex-desktop', 'vscode-byok', 'codemie-daemon'])('%s: the Claude normalizer leaves the body alone', async (client) => {
      harness = await startDaemonHarness();

      await postJson(harness.proxyUrl, '/v1/messages', THINKING, keyOf(client));

      expect(harness.lastForwarded()?.body).toEqual(THINKING);
    });

    it('vscode-byok: the VS Code normalizer shortens an overlong user on /responses', async () => {
      harness = await startDaemonHarness();
      const user = 'u'.repeat(80);

      await postJson(harness.proxyUrl, '/v1/responses', { model: 'gpt-5.2', user, input: [] }, keyOf('vscode-byok'));

      const forwardedUser = (harness.lastForwarded()?.body as Record<string, unknown>).user as string;
      expect(forwardedUser.length).toBeLessThanOrEqual(32);
      expect(forwardedUser).not.toBe(user);
    });

    it.each(['codex-desktop', 'codemie-daemon'])('%s: the VS Code normalizer leaves the user alone', async (client) => {
      harness = await startDaemonHarness();
      const user = 'u'.repeat(80);

      await postJson(harness.proxyUrl, '/v1/responses', { model: 'gpt-5.2', user, input: [] }, keyOf(client));

      expect((harness.lastForwarded()?.body as Record<string, unknown>).user).toBe(user);
    });
  });

  describe('money: who pays and what is charged, for every client of the daemon', () => {
    const PROJECT = 'daemon-project';
    const SSO_COOKIE = 'synthetic-sso-cookie';
    const PROFILE = 'money-profile';
    const CATALOG = [
      { deployment_name: 'claude-opus-4-5-20251101', enabled: true },
      { deployment_name: 'gpt-5-2-2026-01-15', enabled: true },
      { deployment_name: 'grok-4.6', base_name: 'grok-4.6', label: 'Grok 4.6', enabled: true },
    ];
    /** A Responses request that replays reasoning state, and an upstream that rejects the replay. */
    const REPLAY = {
      model: 'gpt-5-2-2026-01-15',
      include: ['reasoning.encrypted_content'],
      input: [{ type: 'reasoning', encrypted_content: 'abc==' }, { type: 'message', role: 'user', content: 'hi' }],
    };
    const REJECT_REPLAY = (req: http.IncomingMessage) => req.url === '/v1/responses'
      ? { status: 400, body: { error: { code: 'invalid_encrypted_content', message: 'could not be verified' } } }
      : { status: 200, body: { ok: true } };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** The SSO login of the profile for `targetApiUrl`, in the file credential store. */
    async function signIn(targetApiUrl: string): Promise<void> {
      await CredentialStore.getInstance().storeSSOCredentials(
        { cookies: { codemie_access_token: SSO_COOKIE }, apiUrl: targetApiUrl, expiresAt: 4102444800000 },
        targetApiUrl
      );
    }

    /**
     * The daemon over the profile's SSO login, with its project, its `--model`, a profile that opted into one extra
     * model and the shared key served as `defaultClient`; then one request sent with `key`.
     */
    async function startPaying(
      path: string, body: unknown, key: string, defaultClient = 'codemie-daemon', answer?: Parameters<typeof startHarness>[2]
    ): Promise<Harness> {
      writeFileSync(join(process.env.CODEMIE_HOME!, 'codemie-cli.config.json'), JSON.stringify({
        version: 2, activeProfile: PROFILE, profiles: { [PROFILE]: { provider: 'ai-run-sso', claudeExtraModels: ['grok-4.6'] } },
      }));
      const started = await startHarness({
        gatewayKey: GATEWAY_KEY, clientType: defaultClient, provider: 'ai-run-sso', authMethod: 'sso', jwtToken: undefined,
        profile: PROFILE, project: PROJECT, model: 'gpt-5.2', version: '1.2.3',
      }, CATALOG, answer, signIn);
      await postJson(started.proxyUrl, path, body, key);
      return started;
    }

    /** What the backend charges by reached the upstream on exactly one request: CLI, project, cookie, model; no gateway key. */
    function expectCharged(started: Harness, path: string, model: string): void {
      const requests = started.allForwarded().filter((request) => request.url === path);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request.headers['x-codemie-cli']).toBe('codemie-cli/1.2.3');
      expect(request.headers['x-codemie-project']).toBe(PROJECT);
      expect(request.headers.cookie).toContain(SSO_COOKIE);
      expect(String(request.headers.authorization ?? '')).not.toContain(GATEWAY_KEY);
      expect(request.body?.model).toBe(model);
    }

    /** The model each client's own daemon forwards today, for the request it sends. */
    const MODEL_TABLE: Array<[string, string, string, unknown, string]> = [
      ['claude-desktop', 'a Claude-family name', '/v1/messages', { model: 'claude-opus-4-5', messages: [] }, 'claude-opus-4-5-20251101'],
      ['claude-desktop', 'a title-generation prompt', '/v1/messages',
        { model: 'claude-opus-4-5', system: 'Generate a concise, sentence-case title', messages: [] }, 'claude-haiku-4-5-env'],
      ['claude-desktop', 'an extra model alias', '/v1/messages', { model: 'claude-x-44968622fb', messages: [] }, 'grok-4.6'],
      ['vscode-claude-code', 'a Claude-family name', '/v1/messages', { model: 'claude-opus-4-5', messages: [] }, 'claude-opus-4-5-20251101'],
      ['vscode-claude-code', 'a title-generation prompt', '/v1/messages',
        { model: 'claude-opus-4-5', system: 'Generate a concise, sentence-case title', messages: [] }, 'claude-haiku-4-5-env'],
      ['vscode-claude-code', 'an extra model alias', '/v1/messages', { model: 'claude-x-44968622fb', messages: [] }, 'grok-4.6'],
      ['codex-desktop', 'a name the catalog lacks', '/v1/responses', { model: 'gpt-9-unknown', input: [] }, 'gpt-5-2-2026-01-15'],
      ['vscode-byok', 'a name the catalog lacks', '/v1/responses', { model: 'gpt-9-unknown', input: [] }, 'gpt-9-unknown'],
      ['codemie-daemon', 'a name the catalog lacks', '/v1/responses', { model: 'gpt-9-unknown', input: [] }, 'gpt-9-unknown'],
    ];

    it.each(MODEL_TABLE)('%s, %s: charged to the daemon\'s project and CLI, signed in, forwarded once with its model', async (client, _case, path, body, model) => {
      // The Haiku model of the environment, which title generation is sent with
      vi.stubEnv('CODEMIE_HAIKU_MODEL', 'claude-haiku-4-5-env');
      harness = await startPaying(path, body, keyOf(client));

      expectCharged(harness, path, model);
    });

    it.each([
      ['claude-desktop', 'gpt-9-unknown'],
      ['vscode-claude-code', 'gpt-9-unknown'],
      ['codex-desktop', 'gpt-5-2-2026-01-15'],
      ['vscode-byok', 'gpt-9-unknown'],
      ['codemie-daemon', 'gpt-9-unknown'],
    ])('the shared key under the default client %s: charged as every client, forwarded once with model %s', async (defaultClient, model) => {
      harness = await startPaying('/v1/responses', { model: 'gpt-9-unknown', input: [] }, GATEWAY_KEY, defaultClient);

      expectCharged(harness, '/v1/responses', model);
    });

    it('the shared key under the default client codex-desktop carrying a claude-* model is rewritten as for codex-desktop', async () => {
      harness = await startPaying('/v1/responses', { model: 'claude-sonnet-5', input: [] }, GATEWAY_KEY, 'codex-desktop');

      expectCharged(harness, '/v1/responses', 'gpt-5-2-2026-01-15');
    });

    it.each(['codex-desktop', 'vscode-byok'])('no second forward: a 400 with the encrypted-content marker gives %s one upstream request', async (client) => {
      harness = await startPaying('/v1/responses', REPLAY, keyOf(client), 'codemie-daemon', REJECT_REPLAY);

      expect(harness.allForwarded().filter((request) => request.url === '/v1/responses')).toHaveLength(1);
    });

    it('the Copilot retry runs for a codemie-copilot wrapper proxy alone: two upstream requests', async () => {
      harness = await startHarness({ clientType: 'codemie-copilot' }, null, REJECT_REPLAY);

      await postJson(harness.proxyUrl, '/v1/responses', REPLAY);

      expect(harness.allForwarded().filter((request) => request.url === '/v1/responses')).toHaveLength(2);
    });
  });
});
