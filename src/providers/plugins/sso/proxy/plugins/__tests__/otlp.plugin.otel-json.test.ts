/**
 * Tests for `OtlpPlugin`'s POST /v1/analytics/otlp/v1/{logs,metrics,traces} route for the
 * `application/json` content type: parses, masks (`maskSecretsDeep`) and spools the payload
 * as one masked NDJSON line on the signal's own JSON stream, and never falls through to the
 * byte-blind `.bin` path (see code-review-final.local.json CR-007/CR-008).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';

const appendSpoolMock = vi.fn(async (_sessionId: string, _stream: string, _data: string) => {});
vi.mock('../otlp-spool/spool-io.js', () => ({ appendSpool: appendSpoolMock }));

const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('@/utils/logger.js', () => ({ logger: loggerMock }));

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

function otlpJsonContext(
  signal: 'logs' | 'metrics' | 'traces',
  body: string,
  overrides: Partial<ProxyContext> = {}
): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'proxy-session',
    agentName: 'claude-code-otlp',
    method: 'POST',
    url: `/v1/analytics/otlp/v1/${signal}`,
    headers: { 'content-type': 'application/json' },
    requestBody: Buffer.from(body),
    requestStartTime: Date.now(),
    metadata: { gatewayKeyValidated: true },
    ...overrides,
  } as ProxyContext;
}

async function postOtlpJson(
  signal: 'logs' | 'metrics' | 'traces',
  body: string,
  overrides: Partial<ProxyContext> = {}
) {
  const plugin = new OtlpPlugin();
  const interceptor = plugin.createInterceptor({} as never);
  const res = fakeResponse();
  await interceptor.handleRequest(
    otlpJsonContext(signal, body, overrides),
    {} as IncomingMessage,
    res,
    {} as ProxyHTTPClient
  );
  return res;
}

const SESSION_ID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';

describe('OtlpPlugin — POST /v1/analytics/otlp/v1/{signal} (application/json)', () => {
  beforeEach(() => {
    appendSpoolMock.mockReset();
    appendSpoolMock.mockResolvedValue(undefined);
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
  });

  it('rejects with 401 when the gateway key was not validated', async () => {
    const res = await postOtlpJson('logs', JSON.stringify({ sessionId: SESSION_ID }), {
      metadata: { gatewayKeyValidated: false },
    });
    expect(res.statusCode).toBe(401);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });

  it('(CR-008) masks a secret-bearing JSON body and spools it to the signal\'s own JSON stream', async () => {
    const payload = {
      resourceLogs: [{ sessionId: SESSION_ID, attributes: { api_key: 'sk-super-secret-value' } }],
    };
    const res = await postOtlpJson('logs', JSON.stringify(payload));

    expect(res.statusCode).toBe(200);
    expect(appendSpoolMock).toHaveBeenCalledTimes(1);
    const [sessionId, stream, data] = appendSpoolMock.mock.calls[0] as [string, string, string];
    expect(sessionId).toBe(SESSION_ID);
    expect(stream).toBe('logsJson');

    expect(data).not.toContain('sk-super-secret-value');
    const written = JSON.parse(data.trim());
    expect(written.resourceLogs[0].attributes.api_key).not.toBe('sk-super-secret-value');
  });

  it('routes metrics and traces to their own JSON stream', async () => {
    await postOtlpJson('metrics', JSON.stringify({ sessionId: SESSION_ID }));
    expect(appendSpoolMock.mock.calls[0][1]).toBe('metricsJson');

    appendSpoolMock.mockClear();
    await postOtlpJson('traces', JSON.stringify({ sessionId: SESSION_ID }));
    expect(appendSpoolMock.mock.calls[0][1]).toBe('tracesJson');
  });

  it('(CR-007) drops the record and logs a warning on malformed JSON, without falling through to the byte-blind path', async () => {
    // A session id is still found by regex on the raw bytes, even though the body itself is not valid JSON.
    const res = await postOtlpJson('logs', `not json but has a uuid ${SESSION_ID} in it`);

    expect(res.statusCode).toBe(200);
    expect(appendSpoolMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('(CR-007) drops the record and logs a warning, never spooling the original unmasked bytes, when the spool write itself fails', async () => {
    appendSpoolMock.mockRejectedValueOnce(new Error('disk full'));
    const res = await postOtlpJson('logs', JSON.stringify({ sessionId: SESSION_ID, api_key: 'sk-secret' }));

    expect(res.statusCode).toBe(200);
    // Attempted exactly once on the masked-JSON path — never retried via the byte-blind .bin append.
    expect(appendSpoolMock).toHaveBeenCalledTimes(1);
    expect(appendSpoolMock.mock.calls[0][1]).toBe('logsJson');
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('logs and drops without spooling when no session id is present in the JSON body', async () => {
    const res = await postOtlpJson('logs', JSON.stringify({ no: 'session id here' }));

    expect(res.statusCode).toBe(200);
    expect(appendSpoolMock).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalled();
  });
});
