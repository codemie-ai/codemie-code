/**
 * The local daemon's analytics intake: hook batches and OTLP exports into the local spool with no project rule and no
 * stamp loss, the end of a session marked at its hook, the recovered end of a Copilot CLI session whose end hook never
 * came, and the sweep into the analytics folder on its own timer.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';

const scheduleMock = vi.fn();
/** Each recovery pass a sweep runs, so a test can wait for the one its start began. */
const recoveries: Promise<void>[] = [];
/**
 * Registered again for each test: a module `vi.mock` stands in for outlives `vi.resetModules`, and its own imports
 * (the spool root the plugin points at the local spool) would stay those of the first test.
 */
function mockEnrichment(): void {
  vi.doMock('../otlp-spool/copilot-usage-enrichment.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../otlp-spool/copilot-usage-enrichment.js')>();
    return {
      ...actual,
      scheduleCopilotUsageEnrichment: scheduleMock,
      recoverMissingSessionEnds: (...args: Parameters<typeof actual.recoverMissingSessionEnds>) => {
        const pass = actual.recoverMissingSessionEnds(...args);
        recoveries.push(pass);
        return pass;
      },
    };
  });
}

const MINUTE = 60_000;
let home: string;
const fetchMock = vi.fn();

function fakeResponse(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: () => {},
    end(chunk?: string) {
      res.body = chunk ?? '';
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

function context(url: string, body: unknown, headers: Record<string, string> = {}): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'proxy-session',
    agentName: 'claude-code-otlp',
    method: 'POST',
    url,
    headers,
    requestBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    requestStartTime: Date.now(),
    metadata: { gatewayKeyValidated: true },
  } as ProxyContext;
}

async function started() {
  const { LocalAnalyticsPlugin } = await import('../local-analytics.plugin.js');
  const interceptor = new LocalAnalyticsPlugin().createInterceptor();
  await interceptor.onProxyStart?.();
  const post = async (url: string, body: unknown, headers?: Record<string, string>) => {
    const res = fakeResponse();
    const handled = await interceptor.handleRequest!(context(url, body, headers), {} as IncomingMessage, res, {} as ProxyHTTPClient);
    return { handled, res };
  };
  return { interceptor, post };
}

const SID = '11111111-2222-4333-8444-555555555555';
const localSpool = () => join(home, 'analytics', 'spool');
const status = (sessionId = SID) => JSON.parse(readFileSync(join(localSpool(), `${sessionId}.status`), 'utf-8')) as Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  mockEnrichment();
  home = mkdtempSync(join(tmpdir(), 'local-analytics-'));
  vi.stubEnv('CODEMIE_HOME', home);
  // The recovery reads Copilot's own folder under the user's home: the temp directory stands for it.
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('COPILOT_HOME', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  scheduleMock.mockReset();
  recoveries.length = 0;
  (await import('../otlp-spool/copilot-usage-enrichment.js')).resetScheduledForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await (await import('@/utils/logger.js')).logger.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('LocalAnalyticsPlugin', () => {
  it('a batch of two project names leaves no project mark, conflict or seal, and warns of nothing', async () => {
    const { logger } = await import('@/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    const { interceptor, post } = await started();

    const { res } = await post('/v1/analytics/hooks', {
      agentName: 'claude-code-otlp',
      hookEvents: [
        { type: 'agent.prompt.submit', session_id: SID, codemie_project_name: 'alpha' },
        { type: 'agent.tool.start', session_id: SID, codemie_project_name: 'beta' },
      ],
    });
    await interceptor.onProxyStop?.();

    expect(res.statusCode).toBe(202);
    const written = status();
    expect(written).not.toHaveProperty('project');
    expect(written).not.toHaveProperty('projectConflict');
    expect(written).not.toHaveProperty('projectSeal');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a batch with agent.session.end marks the session ended; one without does not', async () => {
    const other = '11111111-2222-4333-8444-666666666666';
    const { interceptor, post } = await started();

    await post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 'agent.session.end', session_id: SID }] });
    await post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 'agent.session.stop', session_id: other }] });
    await interceptor.onProxyStop?.();

    expect(status(SID).endedAt).toEqual(expect.any(Number));
    expect(status(other)).not.toHaveProperty('endedAt');
  });

  it('a Copilot CLI session end schedules the usage enrichment with the whole batch', async () => {
    const { interceptor, post } = await started();
    const events = [{ type: 'agent.session.end', session_id: SID }];

    await post('/v1/analytics/hooks', { agentName: 'copilot-cli-otlp', hookEvents: events });
    await interceptor.onProxyStop?.();

    expect(scheduleMock).toHaveBeenCalledWith('copilot-cli-otlp', events);
  });

  it('every file lands under the local spool, none under the proxy spool', async () => {
    const { interceptor, post } = await started();

    await post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 't', session_id: SID }] });
    await post('/v1/analytics/otlp/v1/logs', { resourceLogs: [{ resource: { attributes: [{ key: 'session.id', value: { stringValue: SID } }] } }] }, { 'content-type': 'application/json' });
    await interceptor.onProxyStop?.();

    expect(readdirSync(localSpool()).sort()).toEqual([`${SID}.hooks.ndjson`, `${SID}.otel_logs.ndjson`, `${SID}.status`, 'epoch.json']);
    expect(existsSync(join(home, 'proxy', 'otlp-spool'))).toBe(false);
  });

  it('edge: a batch with an evidence_loss alone is answered and writes no file', async () => {
    const { interceptor, post } = await started();

    const { res } = await post('/v1/analytics/hooks', {
      agentName: 'claude-code-otlp',
      hookEvents: [],
      evidence_loss: { session_id: SID, reason: 'no_login', events: 2 },
    });
    await interceptor.onProxyStop?.();

    expect(res.statusCode).toBe(202);
    expect(existsSync(localSpool())).toBe(false);
  });

  it('runs no tick over three send intervals, and its sweep timer moves a session past its grace', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { interceptor, post } = await started();
    await post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 'agent.session.end', session_id: SID }] });

    await vi.advanceTimersByTimeAsync(3 * 2 * MINUTE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ cursors: { hooks: 0 } });

    await vi.advanceTimersByTimeAsync(2 * 15 * MINUTE);
    // The limit guards a hung move; the move itself is real file work.
    await vi.waitFor(() => expect(existsSync(join(home, 'analytics', 'sessions', `${SID}.hooks.jsonl`))).toBe(true), { timeout: 10_000 });
    await interceptor.onProxyStop?.();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a start sweeps at once, with no timer advanced, and its interval sweeps go on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const other = '11111111-2222-4333-8444-666666666666';
    const folderFile = (sessionId: string) => join(home, 'analytics', 'sessions', `${sessionId}.hooks.jsonl`);
    const first = await started();
    await first.post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 'agent.session.end', session_id: SID }] });
    await first.interceptor.onProxyStop?.();
    vi.setSystemTime(Date.now() + 30 * MINUTE);

    const second = await started();
    // The limit guards a hung move; the move itself is real file work.
    await vi.waitFor(() => expect(existsSync(folderFile(SID))).toBe(true), { timeout: 10_000 });

    await second.post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 'agent.session.end', session_id: other }] });
    expect(existsSync(folderFile(other))).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 15 * MINUTE);
    await vi.waitFor(() => expect(existsSync(folderFile(other))).toBe(true), { timeout: 10_000 });
    await second.interceptor.onProxyStop?.();
  });

  it('a stop right after a start returns only once the sweep the start began has moved the session', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const first = await started();
    await first.post('/v1/analytics/hooks', { agentName: 'claude-code-otlp', hookEvents: [{ type: 'agent.session.end', session_id: SID }] });
    await first.interceptor.onProxyStop?.();
    vi.setSystemTime(Date.now() + 30 * MINUTE);

    const second = await started();
    await second.interceptor.onProxyStop?.();

    const folder = join(home, 'analytics', 'sessions');
    expect(existsSync(join(folder, `${SID}.hooks.jsonl`))).toBe(true);
    expect(existsSync(join(folder, `${SID}.moving`))).toBe(false);
    expect(readdirSync(localSpool()).filter((name) => name.startsWith(SID))).toEqual([]);
  });

  describe('a JSON export goes to the file of the session each record names', () => {
    const B = '11111111-2222-4333-8444-777777777777';
    const JSON_TYPE = { 'content-type': 'application/json' };
    const sid = (key: string, id: string) => ({ key, value: { stringValue: id } });
    const lines = (sessionId: string, signal: string) =>
      readFileSync(join(localSpool(), `${sessionId}.otel_${signal}.ndjson`), 'utf-8').trimEnd().split('\n').map((l) => JSON.parse(l) as unknown);
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] };
    const scope = { name: 'com.anthropic.claude_code' };

    it('a metrics export of two sessions: each file holds its own points alone, the resource and scope kept', async () => {
      const { interceptor, post } = await started();
      const point = (id: string, n: string) => ({ asInt: n, attributes: [sid('session.id', id)] });
      await post('/v1/analytics/otlp/v1/metrics', {
        resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [
          { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [point(SID, '1'), point(B, '2'), point(SID, '3')] } },
          { name: 'claude_code.session.count', sum: { dataPoints: [point(B, '4')] } },
        ] }] }],
      }, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(lines(SID, 'metrics')).toEqual([{ resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [
        { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [point(SID, '1'), point(SID, '3')] } },
      ] }] }] }]);
      expect(lines(B, 'metrics')).toEqual([{ resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [
        { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [point(B, '2')] } },
        { name: 'claude_code.session.count', sum: { dataPoints: [point(B, '4')] } },
      ] }] }] }]);
    });

    it('a logs export: a record by session.id and one by session_id each go to their own session', async () => {
      const { interceptor, post } = await started();
      const a = { body: { stringValue: 'a' }, attributes: [sid('session.id', SID)] };
      const b = { body: { stringValue: 'b' }, attributes: [sid('session_id', B)] };
      await post('/v1/analytics/otlp/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [a, b] }] }] }, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(lines(SID, 'logs')).toEqual([{ resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [a] }] }] }]);
      expect(lines(B, 'logs')).toEqual([{ resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [b] }] }] }]);
    });

    it('a traces export of two sessions is divided by each span\'s session.id', async () => {
      const { interceptor, post } = await started();
      const a = { name: 'claude_code.interaction', attributes: [sid('session.id', SID)] };
      const b = { name: 'claude_code.llm_request', attributes: [sid('session.id', B)] };
      await post('/v1/analytics/otlp/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [b, a] }] }] }, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(lines(SID, 'traces')).toEqual([{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [a] }] }] }]);
      expect(lines(B, 'traces')).toEqual([{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [b] }] }] }]);
    });

    it('an export of one session is written as the one line it is, to that session\'s file', async () => {
      const { interceptor, post } = await started();
      const body = { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [{ attributes: [sid('session.id', SID)] }, { attributes: [sid('session.id', SID)] }] }] }] };
      await post('/v1/analytics/otlp/v1/logs', body, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(readFileSync(join(localSpool(), `${SID}.otel_logs.ndjson`), 'utf-8')).toBe(JSON.stringify(body) + '\n');
      expect(readdirSync(localSpool()).filter((f) => f.endsWith('.ndjson'))).toEqual([`${SID}.otel_logs.ndjson`]);
    });

    it('edge: a record whose id is no UUID v4 and one with no id stay with the session the export goes to', async () => {
      const { interceptor, post } = await started();
      const a = { attributes: [sid('session.id', SID)] };
      const b = { attributes: [sid('session.id', B)] };
      const notUuid = { attributes: [sid('session.id', '../not-a-session')] };
      const none = { attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }] };
      await post('/v1/analytics/otlp/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [a, notUuid, b, none] }] }] }, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(lines(SID, 'logs')).toEqual([{ resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [a, notUuid, none] }] }] }]);
      expect(lines(B, 'logs')).toEqual([{ resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [b] }] }] }]);
    });

    it('a request whose first UUID is a third session keeps the record that names no session in that session\'s file', async () => {
      const { interceptor, post } = await started();
      const C = '11111111-2222-4333-8444-888888888888';
      const own = { attributes: [{ key: 'host.id', value: { stringValue: C } }] };
      const a = { attributes: [sid('session.id', SID)] };
      const b = { attributes: [sid('session.id', B)] };
      const none = { attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }] };
      await post('/v1/analytics/otlp/v1/logs', { resourceLogs: [{ resource: own, scopeLogs: [{ scope, logRecords: [a, b, none] }] }] }, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(readdirSync(localSpool()).filter((f) => f.endsWith('.ndjson')).sort()).toEqual(
        [`${SID}.otel_logs.ndjson`, `${B}.otel_logs.ndjson`, `${C}.otel_logs.ndjson`].sort()
      );
      expect(lines(SID, 'logs')).toEqual([{ resourceLogs: [{ resource: own, scopeLogs: [{ scope, logRecords: [a] }] }] }]);
      expect(lines(B, 'logs')).toEqual([{ resourceLogs: [{ resource: own, scopeLogs: [{ scope, logRecords: [b] }] }] }]);
      expect(lines(C, 'logs')).toEqual([{ resourceLogs: [{ resource: own, scopeLogs: [{ scope, logRecords: [none] }] }] }]);
    });

    it('a request whose first UUID is a third session and whose only unnamed parts are a scope with no records and a metric of no known kind keeps them in that session\'s file', async () => {
      const { interceptor, post } = await started();
      const C = '11111111-2222-4333-8444-888888888888';
      const own = { attributes: [{ key: 'host.id', value: { stringValue: C } }] };
      const point = (id: string) => ({ asInt: '1', attributes: [sid('session.id', id)] });
      const a = { name: 'claude_code.token.usage', sum: { dataPoints: [point(SID)] } };
      const b = { name: 'claude_code.token.usage', sum: { dataPoints: [point(B)] } };
      const unknownKind = { name: 'claude_code.other', other: { dataPoints: [] } };
      const emptyScope = { scope: { name: 'empty' }, metrics: [] };
      await post('/v1/analytics/otlp/v1/metrics', { resourceMetrics: [{ resource: own, scopeMetrics: [{ scope, metrics: [a, b, unknownKind] }, emptyScope] }] }, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(readdirSync(localSpool()).filter((f) => f.endsWith('.ndjson')).sort()).toEqual(
        [`${SID}.otel_metrics.ndjson`, `${B}.otel_metrics.ndjson`, `${C}.otel_metrics.ndjson`].sort()
      );
      expect(lines(SID, 'metrics')).toEqual([{ resourceMetrics: [{ resource: own, scopeMetrics: [{ scope, metrics: [a] }] }] }]);
      expect(lines(B, 'metrics')).toEqual([{ resourceMetrics: [{ resource: own, scopeMetrics: [{ scope, metrics: [b] }] }] }]);
      expect(lines(C, 'metrics')).toEqual([{ resourceMetrics: [{ resource: own, scopeMetrics: [{ scope, metrics: [unknownKind] }, emptyScope] }] }]);
    });

    it('a request whose records all name one session goes to that session, not to the first UUID of its text', async () => {
      const { interceptor, post } = await started();
      const own = { attributes: [{ key: 'host.id', value: { stringValue: SID } }] };
      const body = { resourceLogs: [{ resource: own, scopeLogs: [{ scope, logRecords: [{ attributes: [sid('session.id', B)] }] }] }] };
      await post('/v1/analytics/otlp/v1/logs', body, JSON_TYPE);
      await interceptor.onProxyStop?.();

      expect(readdirSync(localSpool()).filter((f) => f.endsWith('.ndjson'))).toEqual([`${B}.otel_logs.ndjson`]);
      expect(readFileSync(join(localSpool(), `${B}.otel_logs.ndjson`), 'utf-8')).toBe(JSON.stringify(body) + '\n');
    });
  });

  describe('a Copilot CLI session whose end hook never came', () => {
    let session: string;
    const T0 = Date.parse('2026-10-20T06:25:00.000Z');
    const at = (ms: number): string => new Date(T0 + ms).toISOString();
    const identity = { developer_name: 'dev@example.com', platform: 'copilot-cli', entrypoint: 'native' };
    const hook = (type: string, ms: number) => ({ type, session_id: session, timestamp: at(ms), event_id: `${type}:${ms}`, ...identity });
    const line = (type: string, ms: number, data: Record<string, unknown>): string => JSON.stringify({ type, timestamp: at(ms), data });
    const hooksFile = () => join(localSpool(), `${session}.hooks.ndjson`);
    const spooled = (): Record<string, unknown>[] =>
      readFileSync(hooksFile(), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(JSON.parse(l).hookEvent) as Record<string, unknown>);
    const ends = () => spooled().filter((event) => event['type'] === 'agent.session.end');

    /** Copilot's transcript of one finished run, its file aged past the recovery's settle time. */
    function writeTranscript(): void {
      const dir = join(home, '.copilot', 'session-state', session);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'events.jsonl');
      writeFileSync(file, [
        line('session.start', 0, { startTime: at(0), copilotVersion: '1.0.92' }),
        line('session.shutdown', 5_000, {
          modelMetrics: { 'gpt-6-luna': { requests: { count: 1 }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
        }),
      ].join('\n') + '\n');
      const aged = new Date(Date.now() - 60_000);
      utimesSync(file, aged, aged);
    }

    /** A start of the proxy, its sweep's recovery and the usage pass that recovery begins, waited for. */
    async function sweep() {
      const run = await started();
      await vi.waitFor(() => expect(recoveries).toHaveLength(1));
      await recoveries.splice(0)[0];
      // The limit guards a hung usage pass; the pass itself is real file work.
      await vi.waitFor(() => expect(spooled().some((event) => event['type'] === 'agent.session.summary')).toBe(true), { timeout: 10_000 });
      return run;
    }

    beforeEach(() => {
      session = randomUUID();
    });

    it('a sweep writes the end its transcript holds; a later end hook is answered 202 and not written again', async () => {
      const first = await started();
      await vi.waitFor(() => expect(recoveries).toHaveLength(1));
      await recoveries.splice(0)[0];
      await first.post('/v1/analytics/hooks', { agentName: 'copilot-cli-otlp', hookEvents: [hook('agent.session.start', 0)] });
      await first.interceptor.onProxyStop?.();
      writeTranscript();

      const second = await sweep();
      expect(ends()).toHaveLength(1);

      const { res } = await second.post('/v1/analytics/hooks', { agentName: 'copilot-cli-otlp', hookEvents: [hook('agent.session.end', 4_900)] });
      await second.interceptor.onProxyStop?.();
      expect(res.statusCode).toBe(202);
      expect(ends()).toHaveLength(1);
    });

    it('edge: a second sweep over the same session still holds one end', async () => {
      const first = await started();
      await vi.waitFor(() => expect(recoveries).toHaveLength(1));
      await recoveries.splice(0)[0];
      await first.post('/v1/analytics/hooks', { agentName: 'copilot-cli-otlp', hookEvents: [hook('agent.session.start', 0)] });
      await first.interceptor.onProxyStop?.();
      writeTranscript();
      await (await sweep()).interceptor.onProxyStop?.();

      const third = await sweep();
      await third.interceptor.onProxyStop?.();
      expect(ends()).toHaveLength(1);
    });

    it('a session with no Copilot transcript: its spool untouched by the recovery', async () => {
      const first = await started();
      await vi.waitFor(() => expect(recoveries).toHaveLength(1));
      await recoveries.splice(0)[0];
      await first.post('/v1/analytics/hooks', { agentName: 'copilot-cli-otlp', hookEvents: [hook('agent.session.start', 0)] });
      await first.interceptor.onProxyStop?.();
      const before = readFileSync(hooksFile(), 'utf-8');

      const second = await started();
      await vi.waitFor(() => expect(recoveries).toHaveLength(1));
      await recoveries.splice(0)[0];
      await second.interceptor.onProxyStop?.();

      expect(readFileSync(hooksFile(), 'utf-8')).toBe(before);
    });
  });

  it('leaves every other request to the next plugin', async () => {
    const { interceptor, post } = await started();

    const { handled } = await post('/v1/messages', {});
    await interceptor.onProxyStop?.();

    expect(handled).toBe(false);
  });
});
