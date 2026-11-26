/**
 * The local daemon's analytics intake: hook batches and OTLP exports into the local spool with no project rule and no
 * stamp loss, the end of a session marked at its hook, and the sweep into the analytics folder on its own timer.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';

const scheduleMock = vi.fn();
vi.mock('../otlp-spool/copilot-usage-enrichment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../otlp-spool/copilot-usage-enrichment.js')>()),
  scheduleCopilotUsageEnrichment: scheduleMock,
}));

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

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'local-analytics-'));
  vi.stubEnv('CODEMIE_HOME', home);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  scheduleMock.mockReset();
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

  it('leaves every other request to the next plugin', async () => {
    const { interceptor, post } = await started();

    const { handled } = await post('/v1/messages', {});
    await interceptor.onProxyStop?.();

    expect(handled).toBe(false);
  });
});
