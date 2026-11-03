/**
 * Integration: no raw secret leaves the CLI through the analytics pipeline.
 *
 * Real components: the proxy's OTLP ingest (`OtlpPlugin`, JSON path), the hook adapter base class
 * (`OtlpAgentAdapter`), the hook client (`forwardOtlpEventsToSpool`), the on-disk spool and the
 * real forwarder (`forwardSession`), and git branch/remote detection against a real temporary
 * repository whose `origin` URL embeds a token. Faked, as the external boundaries: `fetch` (it records
 * what would reach the backend and what the hook client sends to the local daemon, and routes the
 * latter into the real ingest), the daemon state read (no daemon process runs) and the hook
 * credential lookup (no SSO login exists). The spool lives in an isolated CODEMIE_HOME.
 *
 * Scope: http/json only. Protobuf OTLP is byte-blind and unmasked by design, so it is not covered.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setupTestIsolation } from '../helpers/test-isolation.js';
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace.js';

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
const FAKE_REMOTE_TOKEN = 'ghp_remotetokenabcdefghijklmnopqrstuvw01'; // gitleaks:allow
// Values under secret-named keys that match no secret pattern, so only key-name redaction can catch
// them. The quote, slash, plus and equals sign make their JSON-escaped and URL-encoded spellings differ.
const KEY_NAMED_OTLP_VALUE = 'otlp plain/value+no=pattern "quoted"';
const KEY_NAMED_HOOK_VALUE = 'hook plain/value+no=pattern "quoted"';
const SECRETS = [FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY, FAKE_REMOTE_TOKEN, KEY_NAMED_OTLP_VALUE, KEY_NAMED_HOOK_VALUE];
const REDACTED = '[REDACTED]';

// Non-secret field carried by every payload, proving no body was emptied to pass.
const VISIBLE_MARKER = 'integration-marker-visible';

const SESSION_ID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const PROJECT = 'integration-project';
const PROXY_URL = 'http://proxy.local.test';
const BACKEND_URL = 'https://backend.example.test';
const GATEWAY_KEY = 'gateway-key-for-test';
const HOOK_AGENT_NAME = 'claude-code-otlp';
const DAEMON_HOOKS_PATH = '/v1/analytics/hooks';
const JSON_SPOOL_STREAMS: SpoolStream[] = ['hooks', 'logsJson', 'metricsJson', 'tracesJson'];

type OtlpSignal = 'logs' | 'metrics' | 'traces';
const OTLP_SIGNALS: readonly OtlpSignal[] = ['logs', 'metrics', 'traces'];

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string };
}

interface CapturedRequest {
  url: string;
  contentType: string;
  project: string | undefined;
  body: string;
}

interface DaemonRequest {
  url: string;
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

interface RecordedResponse {
  res: ServerResponse;
  /** 0 until the handler sets a status, so a handler that never answers is caught. */
  status: () => number;
  ended: () => boolean;
  body: () => Buffer;
}

/** A `ServerResponse` stand-in with what the ingest handlers use: `statusCode`, `setHeader` and `end`. */
function fakeServerResponse(): RecordedResponse {
  const chunks: Buffer[] = [];
  let ended = false;
  const res = {
    statusCode: 0,
    setHeader: () => res,
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      ended = true;
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => res.statusCode,
    ended: () => ended,
    body: () => Buffer.concat(chunks),
  };
}

/** The parsed value of a string holding a JSON object or array, else undefined. */
function parseJsonContainer(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Every key and string inside the JSON document(s) of a body (a JSON object or NDJSON), decoded. A string
 * that itself holds a JSON object or array (the spooled `hookEvent`, a hook's `tool_input`) is decoded too.
 */
function decodedStrings(body: string): string[] {
  const documents = body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      const nested = parseJsonContainer(node);
      if (nested !== undefined) {
        walk(nested);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        out.push(key);
        walk(value);
      }
    }
  };
  documents.forEach(walk);
  return out;
}

/** Raw, JSON-escaped, \\u-escaped and URL-encoded spellings of a secret (the key-named values make each one distinct). */
function secretSpellings(secret: string): string[] {
  const unicodeEscaped = [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  return [secret, JSON.stringify(secret).slice(1, -1), unicodeEscaped, encodeURIComponent(secret)];
}

/**
 * No secret under any common spelling, neither in the raw bytes nor in any decoded JSON string. The
 * decoded strings matter for JSON nested in a string (a hook's `tool_input`), escaped once more.
 */
function expectNoSecret(body: string, label: string): void {
  for (const text of [body, ...decodedStrings(body)]) {
    for (const secret of SECRETS) {
      for (const spelling of secretSpellings(secret)) {
        expect(text, `${label} leaked a raw secret`).not.toContain(spelling);
      }
    }
  }
}

/** One seeded field: still a string, carries the redaction marker, and no secret survives in it. */
function expectFieldRedacted(value: unknown, label: string): void {
  expect(value, `${label} is missing`).toBeTypeOf('string');
  expect(value, `${label} was not redacted`).toContain(REDACTED);
  for (const secret of SECRETS) {
    expect(value, `${label} kept a raw secret`).not.toContain(secret);
  }
}

function attributeValue(attributes: OtlpKeyValue[] | undefined, key: string): string | undefined {
  return attributes?.find((attribute) => attribute.key === key)?.value.stringValue;
}

describe('analytics pipeline: secrets in JSON OTLP and hook events', () => {
  setupTestIsolation();

  const backendRequests: CapturedRequest[] = [];
  const daemonRequests: DaemonRequest[] = [];
  /** Spool content right after ingest, before the forwarder may advance cursors or clean up. */
  const spoolSnapshot = new Map<SpoolStream, string>();
  const originalProject = process.env.CODEMIE_PROJECT;
  let workspace: TempWorkspace | undefined;

  /** Real ingest, reached the way the hook client reaches it: over the (stubbed) local daemon URL. */
  async function ingestLocally(path: string, headers: Headers, body: string): Promise<Response> {
    const interceptor = new OtlpPlugin().createInterceptor({} as never);
    const recorded = fakeServerResponse();
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
    if (!interceptor.handleRequest) {
      throw new Error('OtlpPlugin interceptor has no handleRequest');
    }
    await interceptor.handleRequest(ctx, {} as IncomingMessage, recorded.res, {} as ProxyHTTPClient);
    if (!recorded.ended() || recorded.status() === 0) {
      throw new Error(`ingest of ${path} did not answer (status ${recorded.status()}, ended: ${recorded.ended()})`);
    }
    const answer = recorded.body();
    return new Response(answer.length > 0 ? answer : null, { status: recorded.status() });
  }

  function otlpJson(signal: OtlpSignal): string {
    const attributes = [
      { key: 'marker', value: { stringValue: VISIBLE_MARKER } },
      { key: 'tool_input', value: { stringValue: `git push https://x:${FAKE_GITHUB_TOKEN}@github.com/org/repo` } },
      { key: 'api_key', value: { stringValue: KEY_NAMED_OTLP_VALUE } },
    ];
    const resource = { attributes: [{ key: 'session.id', value: { stringValue: SESSION_ID } }] };
    if (signal === 'logs') {
      return JSON.stringify({
        resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{ body: { stringValue: `pasted ${FAKE_OPENAI_KEY}` }, attributes }] }] }],
      });
    }
    if (signal === 'metrics') {
      const dataPoint = { asInt: '1', attributes };
      const metric = { name: 'claude_code.token.usage', description: `usage for ${FAKE_OPENAI_KEY}`, sum: { dataPoints: [dataPoint] } };
      return JSON.stringify({ resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [metric] }] }] });
    }
    return JSON.stringify({
      resourceSpans: [{ resource, scopeSpans: [{ spans: [{ name: `call with ${FAKE_OPENAI_KEY}`, attributes }] }] }],
    });
  }

  beforeAll(async () => {
    process.env.CODEMIE_PROJECT = PROJECT;
    // A real repository whose origin URL embeds a token: branch and remote detection run for real.
    const repo = createTempWorkspace('codemie-secret-egress-');
    workspace = repo;
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo.path, stdio: 'ignore', windowsHide: true });
    };
    git('init', '-q');
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('remote', 'add', 'origin', `https://x-access-token:${FAKE_REMOTE_TOKEN}@github.com/org/repo.git`);

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
        daemonRequests.push({ url, body });
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
      tool_input: {
        command: `curl -H "Authorization: Bearer ${FAKE_OPENAI_KEY}" https://api.example.test`,
        api_key: KEY_NAMED_HOOK_VALUE,
      },
      tool_response: `OPENAI_API_KEY=${FAKE_OPENAI_KEY}`,
      error: `rejected token ${FAKE_GITHUB_TOKEN}`,
      description: VISIBLE_MARKER,
    };
    await new TestHookAdapter().processOtlpEvent(
      JSON.stringify({ cwd: repo.path, payload: [hookEvent] }),
      { ensureOtlpProxy: async () => {}, forwardOtlpEventsToSpool }
    );

    // 2. JSON OTLP path for every signal, through the real ingest.
    for (const signal of OTLP_SIGNALS) {
      const response = await fetch(`${PROXY_URL}/v1/analytics/otlp/v1/${signal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
        body: otlpJson(signal),
      });
      expect(response.status).toBe(200);
    }

    // 3. Snapshot the spool before forwarding: what was written to disk, whatever delivery does to it later.
    for (const stream of JSON_SPOOL_STREAMS) {
      spoolSnapshot.set(stream, await readFile(streamFile(SESSION_ID, stream), 'utf-8'));
    }

    // 4. Real forwarder drains the spool to the (recorded) backend.
    await forwardSession(SESSION_ID, false, { cookies: { codemie_access_token: 'fake-token' }, apiUrl: BACKEND_URL });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    workspace?.cleanup();
    if (originalProject === undefined) {
      delete process.env.CODEMIE_PROJECT;
    } else {
      process.env.CODEMIE_PROJECT = originalProject;
    }
  });

  const byUrlSuffix = (suffix: string): CapturedRequest[] => backendRequests.filter((r) => r.url.endsWith(suffix));

  const otlpRecord = (signal: OtlpSignal): Record<string, unknown> =>
    JSON.parse(byUrlSuffix(`/cli-analytics/${signal}`)[0].body) as Record<string, unknown>;

  it('forwards one hooks batch and one logs, metrics and traces record', () => {
    expect(byUrlSuffix('/event-hooks')).toHaveLength(1);
    expect(byUrlSuffix('/event-hooks')[0].contentType).toBe('application/x-ndjson');
    for (const signal of OTLP_SIGNALS) {
      expect(byUrlSuffix(`/cli-analytics/${signal}`), signal).toHaveLength(1);
      expect(byUrlSuffix(`/cli-analytics/${signal}`)[0].contentType, signal).toBe('application/json');
    }
    expect(backendRequests).toHaveLength(4);
  });

  it('sends no raw secret to the backend in any stream, and every body still carries the non-secret field', () => {
    expect(backendRequests.length).toBeGreaterThan(0);
    for (const request of backendRequests) {
      expectNoSecret(request.body, request.url);
      expect(request.body, `${request.url} lost the non-secret field`).toContain(VISIBLE_MARKER);
      expect(request.project).toBe(PROJECT);
    }
  });

  it('masks the hook event before it leaves the hook process, on the hop to the local daemon', () => {
    const hookPosts = daemonRequests.filter((request) => request.url.endsWith(DAEMON_HOOKS_PATH));
    expect(hookPosts).toHaveLength(1);
    expectNoSecret(hookPosts[0].body, DAEMON_HOOKS_PATH);
    const { hookEvents } = JSON.parse(hookPosts[0].body) as { hookEvents: Record<string, unknown>[] };
    expect(hookEvents).toHaveLength(1);
    for (const field of ['prompt', 'tool_input', 'tool_response', 'error']) {
      expectFieldRedacted(hookEvents[0][field], `daemon hop ${field}`);
    }
    expect(JSON.parse(String(hookEvents[0].tool_input)).api_key, 'daemon hop tool_input.api_key').toBe(REDACTED);
  });

  it('replaces the secrets in the forwarded hook event with the redaction marker', () => {
    const lines = byUrlSuffix('/event-hooks')[0].body.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as Record<string, string>;
    expect(event.session_id).toBe(SESSION_ID);
    expect(event.description).toBe(VISIBLE_MARKER);
    for (const field of ['prompt', 'prompt_body', 'tool_input', 'tool_response', 'error']) {
      expectFieldRedacted(event[field], `hook event ${field}`);
    }
    expect(JSON.parse(event.tool_input).api_key, 'hook event tool_input.api_key').toBe(REDACTED);
  });

  it('forwards the real git remote and branch without the credentials embedded in the remote URL', () => {
    const event = JSON.parse(byUrlSuffix('/event-hooks')[0].body.trim()) as Record<string, string>;
    expect(event.git_branch).toBe('main');
    expect(event.repo_remote).toBe('org/repo');
  });

  it('redacts every seeded field of the forwarded logs record', () => {
    const { resourceLogs } = otlpRecord('logs') as {
      resourceLogs: { scopeLogs: { logRecords: { body: { stringValue?: string }; attributes: OtlpKeyValue[] }[] }[] }[];
    };
    const logRecord = resourceLogs[0].scopeLogs[0].logRecords[0];
    expectFieldRedacted(logRecord.body.stringValue, 'log body');
    expectFieldRedacted(attributeValue(logRecord.attributes, 'tool_input'), 'log tool_input');
    expect(attributeValue(logRecord.attributes, 'api_key'), 'log api_key').toBe(REDACTED);
    expect(attributeValue(logRecord.attributes, 'marker')).toBe(VISIBLE_MARKER);
  });

  it('redacts every seeded field of the forwarded traces record', () => {
    const { resourceSpans } = otlpRecord('traces') as {
      resourceSpans: { scopeSpans: { spans: { name: string; attributes: OtlpKeyValue[] }[] }[] }[];
    };
    const span = resourceSpans[0].scopeSpans[0].spans[0];
    expectFieldRedacted(span.name, 'span name');
    expectFieldRedacted(attributeValue(span.attributes, 'tool_input'), 'span tool_input');
    expect(attributeValue(span.attributes, 'api_key'), 'span api_key').toBe(REDACTED);
    expect(attributeValue(span.attributes, 'marker')).toBe(VISIBLE_MARKER);
  });

  it('redacts every seeded field of the forwarded metrics record', () => {
    const { resourceMetrics } = otlpRecord('metrics') as {
      resourceMetrics: {
        scopeMetrics: { metrics: { description: string; sum: { dataPoints: { attributes: OtlpKeyValue[] }[] } }[] }[];
      }[];
    };
    const metric = resourceMetrics[0].scopeMetrics[0].metrics[0];
    expectFieldRedacted(metric.description, 'metric description');
    expectFieldRedacted(attributeValue(metric.sum.dataPoints[0].attributes, 'tool_input'), 'metric tool_input');
    expect(attributeValue(metric.sum.dataPoints[0].attributes, 'api_key'), 'metric api_key').toBe(REDACTED);
    expect(attributeValue(metric.sum.dataPoints[0].attributes, 'marker')).toBe(VISIBLE_MARKER);
  });

  it('never wrote a raw secret to the on-disk spool either', () => {
    for (const stream of JSON_SPOOL_STREAMS) {
      const content = spoolSnapshot.get(stream) ?? '';
      expect(content, `${stream} spool is empty`).toContain(VISIBLE_MARKER);
      expectNoSecret(content, `${stream} spool`);
    }
  });
});
