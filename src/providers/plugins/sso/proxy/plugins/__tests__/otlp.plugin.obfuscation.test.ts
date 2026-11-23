/**
 * `OtlpPlugin` routes with analytics obfuscation on: the OTLP/JSON route spools obfuscated content, the
 * protobuf route obfuscates string leaves and answers a non-2xx for a body it must drop.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext } from '../../proxy-types.js';
import type { ProxyHTTPClient } from '../../proxy-http-client.js';

const appendSpoolMock = vi.fn(async (_sessionId: string, _stream: string, _data: string | Buffer) => {});
vi.mock('../otlp-spool/spool-io.js', () => ({ appendSpool: appendSpoolMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/analytics-settings.js', () => ({ resolveAnalyticsSettings: () => ({ obfuscation: 'on' }) }));

const { OtlpPlugin } = await import('../otlp.plugin.js');

const SESSION_ID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';

function fakeResponse(): ServerResponse & { statusCode: number } {
  const res = { statusCode: 0, setHeader: () => {}, end: () => {} };
  return res as unknown as ServerResponse & { statusCode: number };
}

async function post(signal: 'logs', contentType: string, body: Buffer) {
  const interceptor = new OtlpPlugin().createInterceptor({} as never);
  const res = fakeResponse();
  const context = {
    requestId: 'req-1',
    sessionId: 'proxy-session',
    agentName: 'claude-code-otlp',
    method: 'POST',
    url: `/v1/analytics/otlp/v1/${signal}`,
    headers: { 'content-type': contentType },
    requestBody: body,
    requestStartTime: Date.now(),
    metadata: { gatewayKeyValidated: true },
  } as unknown as ProxyContext;
  await interceptor.handleRequest(context, {} as IncomingMessage, res, {} as ProxyHTTPClient);
  return res;
}

describe('OtlpPlugin with obfuscation on', () => {
  beforeEach(() => {
    appendSpoolMock.mockReset();
    appendSpoolMock.mockResolvedValue(undefined);
  });

  it('spools an OTLP/JSON body with the email replaced by its placeholder', async () => {
    const payload = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ sessionId: SESSION_ID, body: { stringValue: 'mail bob@example.com' } }] }] }],
    };
    const res = await post('logs', 'application/json', Buffer.from(JSON.stringify(payload)));
    expect(res.statusCode).toBe(200);
    const data = String(appendSpoolMock.mock.calls[0][2]);
    expect(data).toContain('[REDACTED:EMAIL]');
    expect(data).not.toContain('bob@example.com');
  });

  it('spools protobuf string leaves obfuscated', async () => {
    const leaf = (n: number, p: Buffer | string): Buffer => {
      const b = typeof p === 'string' ? Buffer.from(p) : p;
      return Buffer.concat([Buffer.from([n * 8 + 2, b.length]), b]);
    };
    const record = Buffer.concat([leaf(5, leaf(1, 'mail bob@example.com')), leaf(1, SESSION_ID)]);
    const body = leaf(1, leaf(2, leaf(2, record)));
    const res = await post('logs', 'application/x-protobuf', body);
    expect(res.statusCode).toBe(200);
    const spooled = appendSpoolMock.mock.calls[0][2] as Buffer;
    expect(spooled.toString('latin1')).toContain('[REDACTED:EMAIL]');
    expect(spooled.toString('latin1')).not.toContain('bob@example.com');
  });

  it('answers 400 and spools nothing for a malformed protobuf body', async () => {
    const bad = Buffer.concat([Buffer.from(SESSION_ID), Buffer.from([0x0a, 0x7f, 0x01])]);
    const res = await post('logs', 'application/x-protobuf', bad);
    expect(res.statusCode).toBe(400);
    expect(appendSpoolMock).not.toHaveBeenCalled();
  });
});
