/**
 * Integration: no raw secret leaves the CLI through the analytics pipeline.
 *
 * Real components: the proxy's OTLP ingest (`OtlpPlugin`, JSON path), the hook adapter base class
 * (`OtlpAgentAdapter`), the hook client (`forwardOtlpEventsToSpool`), the on-disk spool and the
 * real forwarder (`forwardSession`). Faked: `fetch` (it records what would reach the backend and
 * routes the hook client's call into the real ingest), the daemon state read and the credential
 * lookup. The spool lives in an isolated CODEMIE_HOME.
 *
 * Scope: http/json only. Protobuf OTLP is byte-blind and unmasked by design, so it is not covered.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setupTestIsolation } from '../helpers/test-isolation.js';

const mocks = vi.hoisted(() => ({
  readState: vi.fn(),
}));

vi.mock('../../src/cli/commands/proxy/daemon-manager.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/cli/commands/proxy/daemon-manager.js')>(
    '../../src/cli/commands/proxy/daemon-manager.js'
  )),
  readState: mocks.readState,
}));
vi.mock('../../src/agents/core/hook-credentials.js', () => ({
  resolveHookCredentials: vi.fn(async () => null),
}));
vi.mock('../../src/agents/core/identity-resolver.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/agents/core/identity-resolver.js')>(
    '../../src/agents/core/identity-resolver.js'
  )),
  resolveIdentity: vi.fn(async () => ({ developerName: 'dev@example.com', identitySource: 'jwt' })),
}));
vi.mock('../../src/utils/cli-updater.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/cli-updater.js')>('../../src/utils/cli-updater.js')),
  getCurrentCliVersion: vi.fn(async () => '1.0.0'),
}));
vi.mock('../../src/utils/processes.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/processes.js')>('../../src/utils/processes.js')),
  detectGitBranch: vi.fn(async () => 'main'),
  detectGitRemoteRepo: vi.fn(async () => 'org/repo'),
}));

import { OtlpAgentAdapter, type ForwardDecision, type OtlpHookContext } from '../../src/agents/core/OtlpAgentAdapter.js';
import { forwardOtlpEventsToSpool } from '../../src/agents/plugins/utils.js';
import { OtlpPlugin } from '../../src/providers/plugins/sso/proxy/plugins/otlp.plugin.js';
import { forwardSession } from '../../src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.js';
import { streamFile, type SpoolStream } from '../../src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.js';
import type { ProxyContext } from '../../src/providers/plugins/sso/proxy/proxy-types.js';
import type { ProxyHTTPClient } from '../../src/providers/plugins/sso/proxy/proxy-http-client.js';

// Fixed fake secrets (not real credentials).
const FAKE_GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // gitleaks:allow
const FAKE_OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'; // gitleaks:allow
const SECRETS = [FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY];

// Non-secret field carried by every payload, proving no body was emptied to pass.
const VISIBLE_MARKER = 'integration-marker-visible';

const SESSION_ID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const PROJECT = 'integration-project';
const PROXY_URL = 'http://proxy.local.test';
const BACKEND_URL = 'https://backend.example.test';
const GATEWAY_KEY = 'gateway-key-for-test';
const HOOK_AGENT_NAME = 'claude-code-otlp';

interface CapturedRequest {
  url: string;
  contentType: string;
  project: string | undefined;
  body: string;
}

/** Minimal hook adapter: only supplies what the shared flow needs; masking and spooling are the real ones. */
class TestHookAdapter extends OtlpAgentAdapter<{ cwd: string; payload: Record<string, unknown>[] }> {
  readonly name = HOOK_AGENT_NAME;

  protected parseHookInput(raw: string): { cwd: string; payload: Record<string, unknown>[] } | null {
    return JSON.parse(raw) as { cwd: string; payload: Record<string, unknown>[] };
  }
  protected extractHookContext(input: { cwd: string }): OtlpHookContext {
    return { cwd: input.cwd };
  }
  protected async isTracked(): Promise<boolean> {
    return true;
  }
  protected async evaluate(input: { payload: Record<string, unknown>[] }): Promise<ForwardDecision> {
    return { decision: 'forward', payload: input.payload };
  }
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return { platform: 'test-platform' };
  }
  protected resolveEventType(): string {
    return 'agent.test.event';
  }
  protected buildEventId(event: Record<string, unknown>): string {
    return `test-event:${String(event['session_id'])}`;
  }
}

function fakeServerResponse(): ServerResponse & { statusCode: number } {
  const res = { statusCode: 0, setHeader: () => {}, end: () => {} };
  return res as unknown as ServerResponse & { statusCode: number };
}

describe('analytics pipeline: secrets in JSON OTLP and hook events', () => {
  setupTestIsolation();

  const backendRequests: CapturedRequest[] = [];
  const originalProject = process.env.CODEMIE_PROJECT;

  /** Real ingest, reached the way the hook client reaches it: over the (stubbed) local daemon URL. */
  async function ingestLocally(path: string, headers: Headers, body: string): Promise<Response> {
    const interceptor = new OtlpPlugin().createInterceptor({} as never);
    const res = fakeServerResponse();
    const ctx = {
      requestId: 'req-1',
      sessionId: 'proxy-session',
      agentName: HOOK_AGENT_NAME,
      method: 'POST',
      url: path,
      headers: { 'content-type': headers.get('content-type') ?? '' },
      requestBody: Buffer.from(body),
      requestStartTime: 0,
      metadata: { gatewayKeyValidated: headers.get('authorization') === `Bearer ${GATEWAY_KEY}` },
    } as ProxyContext;
    await interceptor.handleRequest(ctx, {} as IncomingMessage, res, {} as ProxyHTTPClient);
    return new Response(null, { status: res.statusCode || 200 });
  }

  function otlpJson(signal: 'logs' | 'traces'): string {
    const attributes = [
      { key: 'marker', value: { stringValue: VISIBLE_MARKER } },
      { key: 'tool_input', value: { stringValue: `git push https://x:${FAKE_GITHUB_TOKEN}@github.com/org/repo` } },
    ];
    const resource = { attributes: [{ key: 'session.id', value: { stringValue: SESSION_ID } }] };
    if (signal === 'logs') {
      return JSON.stringify({
        resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{ body: { stringValue: `pasted ${FAKE_OPENAI_KEY}` }, attributes }] }] }],
      });
    }
    return JSON.stringify({
      resourceSpans: [{ resource, scopeSpans: [{ spans: [{ name: `call with ${FAKE_OPENAI_KEY}`, attributes }] }] }],
    });
  }

  beforeAll(async () => {
    process.env.CODEMIE_PROJECT = PROJECT;
    mocks.readState.mockResolvedValue({
      url: PROXY_URL,
      targetUrl: BACKEND_URL,
      gatewayKey: GATEWAY_KEY,
    });

    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      if (url.startsWith(PROXY_URL)) {
        return ingestLocally(url.slice(PROXY_URL.length), headers, body);
      }
      backendRequests.push({
        url,
        contentType: headers.get('content-type') ?? '',
        project: headers.get('x-codemie-project') ?? undefined,
        body,
      });
      return new Response(null, { status: 200 });
    });

    // 1. Hook path: adapter masks, the real hook client posts to the real ingest, which spools.
    const hookEvent = {
      session_id: SESSION_ID,
      prompt: `deploy using ${FAKE_GITHUB_TOKEN} please`,
      tool_name: 'Bash',
      tool_input: { command: `curl -H "Authorization: Bearer ${FAKE_OPENAI_KEY}" https://api.example.test` },
      tool_response: `OPENAI_API_KEY=${FAKE_OPENAI_KEY}`,
      error: `rejected token ${FAKE_GITHUB_TOKEN}`,
      description: VISIBLE_MARKER,
    };
    await new TestHookAdapter().processOtlpEvent(
      JSON.stringify({ cwd: process.cwd(), payload: [hookEvent] }),
      { ensureOtlpProxy: async () => {}, forwardOtlpEventsToSpool }
    );

    // 2. JSON OTLP path for logs and traces, through the real ingest.
    for (const signal of ['logs', 'traces'] as const) {
      const response = await fetch(`${PROXY_URL}/v1/analytics/otlp/v1/${signal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
        body: otlpJson(signal),
      });
      expect(response.status).toBe(200);
    }

    // 3. Real forwarder drains the spool to the (recorded) backend.
    await forwardSession(SESSION_ID, false, { cookies: { codemie_access_token: 'fake-token' }, apiUrl: BACKEND_URL });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (originalProject === undefined) {
      delete process.env.CODEMIE_PROJECT;
    } else {
      process.env.CODEMIE_PROJECT = originalProject;
    }
  });

  const byUrlSuffix = (suffix: string): CapturedRequest[] => backendRequests.filter((r) => r.url.endsWith(suffix));

  it('forwards one hooks batch, one logs record and one traces record', () => {
    expect(byUrlSuffix('/event-hooks')).toHaveLength(1);
    expect(byUrlSuffix('/cli-analytics/logs')).toHaveLength(1);
    expect(byUrlSuffix('/cli-analytics/traces')).toHaveLength(1);
    expect(backendRequests).toHaveLength(3);
    expect(byUrlSuffix('/event-hooks')[0].contentType).toBe('application/x-ndjson');
    expect(byUrlSuffix('/cli-analytics/logs')[0].contentType).toBe('application/json');
    expect(byUrlSuffix('/cli-analytics/traces')[0].contentType).toBe('application/json');
  });

  // @case secrets-forwarded-hook-payloads-unmasked_TC_007
  it('sends no raw secret to the backend in any stream, and every body still carries the non-secret field', () => {
    expect(backendRequests.length).toBeGreaterThan(0);
    for (const request of backendRequests) {
      for (const secret of SECRETS) {
        expect(request.body, `${request.url} leaked a raw secret`).not.toContain(secret);
      }
      expect(request.body, `${request.url} lost the non-secret field`).toContain(VISIBLE_MARKER);
      expect(request.project).toBe(PROJECT);
    }
  });

  it('replaces the secrets in the forwarded hook event with the redaction marker', () => {
    const lines = byUrlSuffix('/event-hooks')[0].body.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as Record<string, string>;
    expect(event.session_id).toBe(SESSION_ID);
    expect(event.description).toBe(VISIBLE_MARKER);
    expect(event.prompt).toContain('[REDACTED]');
    expect(event.prompt_body).toContain('[REDACTED]');
    expect(event.tool_input).toContain('[REDACTED]');
    expect(event.tool_response).toContain('[REDACTED]');
    expect(event.error).toContain('[REDACTED]');
  });

  it('replaces the secrets in the forwarded logs and traces records with the redaction marker', () => {
    for (const suffix of ['/cli-analytics/logs', '/cli-analytics/traces']) {
      const body = byUrlSuffix(suffix)[0].body;
      expect(JSON.parse(body)).toBeTypeOf('object');
      expect(body, suffix).toContain('[REDACTED]');
    }
  });

  it('never wrote a raw secret to the on-disk spool either', async () => {
    const streams: SpoolStream[] = ['hooks', 'logsJson', 'tracesJson'];
    for (const stream of streams) {
      const content = await readFile(streamFile(SESSION_ID, stream), 'utf-8');
      expect(content, `${stream} spool is empty`).toContain(VISIBLE_MARKER);
      for (const secret of SECRETS) {
        expect(content, `${stream} spool leaked a raw secret`).not.toContain(secret);
      }
    }
  });
});
