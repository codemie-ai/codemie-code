/**
 * Tests for `OtlpPlugin`'s `/v1/analytics/hooks` route: one hook invocation's batch is appended
 * to the spool as a single write, so the client's commit decision can be a single boolean
 * (honest 500 on a spool-write failure, 202 only once the batch is actually durable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';

const appendSpoolMock = vi.fn(async (_sessionId: string, _stream: string, _data: string) => {});
vi.mock('../otlp-spool/spool-io.js', () => ({ appendSpool: appendSpoolMock }));

const getAnalyticsAgentMock = vi.fn((name: string) => (name === 'claude-code-otlp' ? { name } : undefined));
vi.mock('@/agents/registry.js', () => ({
  AgentRegistry: { getAnalyticsAgent: getAnalyticsAgentMock },
}));

const { OtlpPlugin } = await import('../otlp.plugin.js');

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

function hooksContext(body: unknown, overrides: Partial<ProxyContext> = {}): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'proxy-session',
    agentName: 'claude-code-otlp',
    method: 'POST',
    url: '/v1/analytics/hooks',
    headers: {},
    requestBody: typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body)),
    requestStartTime: Date.now(),
    metadata: { gatewayKeyValidated: true },
    ...overrides,
  } as ProxyContext;
}

async function postHooks(body: unknown, overrides: Partial<ProxyContext> = {}) {
  const plugin = new OtlpPlugin();
  const interceptor = plugin.createInterceptor({} as never);
  const res = fakeResponse();
  await interceptor.handleRequest(hooksContext(body, overrides), {} as IncomingMessage, res, {} as ProxyHTTPClient);
  return res;
}

function hookEvent(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'agent.usage.request', session_id: sessionId, ...extra };
}

describe('OtlpPlugin — POST /v1/analytics/hooks', () => {
  beforeEach(() => {
    appendSpoolMock.mockReset();
    appendSpoolMock.mockResolvedValue(undefined);
    getAnalyticsAgentMock.mockClear();
  });

  it('rejects with 401 when the gateway key was not validated', async () => {
    const res = await postHooks(
      { agentName: 'claude-code-otlp', hookEvents: [hookEvent('s1')] },
      { metadata: { gatewayKeyValidated: false } }
    );
    expect(res.statusCode).toBe(401);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 on an empty body', async () => {
    const res = await postHooks('');
    expect(res.statusCode).toBe(400);
  });

  it('rejects with 400 on invalid JSON', async () => {
    const res = await postHooks('not json');
    expect(res.statusCode).toBe(400);
  });

  it('rejects with 400 when hookEvents is missing or not an array', async () => {
    const res = await postHooks({ agentName: 'claude-code-otlp' });
    expect(res.statusCode).toBe(400);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 for an unrecognized agentName', async () => {
    const res = await postHooks({ agentName: 'nope', hookEvents: [hookEvent('s1')] });
    expect(res.statusCode).toBe(400);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });

  it('rejects the whole batch with 400 when events carry more than one non-empty session_id', async () => {
    const res = await postHooks({
      agentName: 'claude-code-otlp',
      hookEvents: [hookEvent('s1'), hookEvent('s2')],
    });
    expect(res.statusCode).toBe(400);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });

  it('accepts with 202 and spools nothing when every event lacks a session_id', async () => {
    const res = await postHooks({
      agentName: 'claude-code-otlp',
      hookEvents: [{ type: 'agent.event' }, { type: 'agent.event' }],
    });
    expect(res.statusCode).toBe(202);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });

  it('discards events without a session_id but keeps the rest of a single-session batch', async () => {
    const res = await postHooks({
      agentName: 'claude-code-otlp',
      hookEvents: [{ type: 'agent.event' }, hookEvent('s1')],
    });
    expect(res.statusCode).toBe(202);
    expect(appendSpoolMock).toHaveBeenCalledTimes(1);
    const [sessionId, stream, data] = appendSpoolMock.mock.calls[0] as [string, string, string];
    expect(sessionId).toBe('s1');
    expect(stream).toBe('hooks');
    expect(data.trim().split('\n')).toHaveLength(1);
  });

  it('appends one spool line per event, in order, under the batch\'s session_id', async () => {
    const events = [hookEvent('s1', { n: 1 }), hookEvent('s1', { n: 2 }), hookEvent('s1', { n: 3 })];
    const res = await postHooks({ agentName: 'claude-code-otlp', hookEvents: events });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });
    expect(appendSpoolMock).toHaveBeenCalledTimes(1);

    const [sessionId, stream, data] = appendSpoolMock.mock.calls[0] as [string, string, string];
    expect(sessionId).toBe('s1');
    expect(stream).toBe('hooks');

    const lines = data.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const decoded = lines.map((line) => {
      const spoolRecord = JSON.parse(line) as { agentName: string; hookEvent: string };
      expect(spoolRecord.agentName).toBe('claude-code-otlp');
      return JSON.parse(spoolRecord.hookEvent) as Record<string, unknown>;
    });
    expect(decoded.map((e) => e['n'])).toEqual([1, 2, 3]);
  });

  it('answers 500, not 202, when the spool write fails', async () => {
    appendSpoolMock.mockRejectedValueOnce(new Error('disk full'));
    const res = await postHooks({ agentName: 'claude-code-otlp', hookEvents: [hookEvent('s1')] });
    expect(res.statusCode).toBe(500);
  });
});
