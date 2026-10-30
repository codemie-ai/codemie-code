/**
 * Tests for `OtlpPlugin`'s POST /v1/analytics/otlp/v1/{logs,metrics,traces} route for the
 * `application/json` content type: parses, masks (`maskSecretsDeep`) and spools the payload
 * as one masked NDJSON line on the signal's own JSON stream, and never falls through to the
 * byte-blind `.bin` path (spec: "Proxy ingestion" and the drop-on-failure acceptance criterion).
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

  it('masks a secret-bearing JSON body and spools it to the signal\'s own JSON stream', async () => {
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

  describe('real OTLP/JSON attribute shape (attributes: [{ key, value: { stringValue } }])', () => {
    // Built from parts so no literal secret-shaped string sits in the source.
    const FAKE_BEARER = 'abcd1234'.repeat(4);
    const FAKE_SK_OLD = 'sk-' + 'A1b2C3d4'.repeat(4);
    const FAKE_SK_NEW = 'sk-' + 'Z9y8X7w6'.repeat(4);

    interface OtlpAttribute {
      key: string;
      value: Record<string, unknown>;
    }

    const stringAttr = (key: string, stringValue: string): OtlpAttribute => ({ key, value: { stringValue } });

    function logsExport(attributes: OtlpAttribute[]): string {
      return JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [stringAttr('service.name', 'claude-code')] },
            scopeLogs: [
              {
                scope: { name: 'com.anthropic.claude_code.events' },
                logRecords: [
                  {
                    timeUnixNano: '1760000000000000000',
                    body: { stringValue: 'claude_code.tool_result' },
                    attributes: [stringAttr('session.id', SESSION_ID), ...attributes],
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    function spooledLine(): string {
      expect(appendSpoolMock).toHaveBeenCalledTimes(1);
      const [, stream, data] = appendSpoolMock.mock.calls[0] as [string, string, string];
      expect(stream).toBe('logsJson');
      expect(data.endsWith('\n')).toBe(true);
      return data;
    }

    function spooledAttributes(line: string): OtlpAttribute[] {
      return JSON.parse(line.trim()).resourceLogs[0].scopeLogs[0].logRecords[0].attributes as OtlpAttribute[];
    }

    it('masks a Bash inline token inside the JSON-encoded tool_parameters string', async () => {
      const toolParameters = JSON.stringify({
        command: `curl -H "Authorization: Bearer ${FAKE_BEARER}" https://api.example.com/v1/items`,
        description: 'List items',
      });
      const res = await postOtlpJson('logs', logsExport([stringAttr('tool_parameters', toolParameters)]));

      expect(res.statusCode).toBe(200);
      const line = spooledLine();
      expect(line).not.toContain(FAKE_BEARER);

      const attributes = spooledAttributes(line);
      expect(attributes.map((a) => a.key)).toEqual(['session.id', 'tool_parameters']);
      expect(attributes[0].value).toEqual({ stringValue: SESSION_ID });
      const params = JSON.parse(attributes[1].value['stringValue'] as string) as { command: string; description: string };
      expect(params.command).toContain('curl -H');
      expect(params.command).toContain('https://api.example.com/v1/items');
      expect(params.command).toContain('[REDACTED]');
      expect(params.description).toBe('List items');
    });

    it('masks keys in an Edit tool_input old_string and new_string, keeping the file path', async () => {
      const toolInput = JSON.stringify({
        file_path: '/repo/src/client.ts',
        old_string: `const client = new Client("${FAKE_SK_OLD}");`,
        new_string: `const client = new Client("${FAKE_SK_NEW}");`,
      });
      await postOtlpJson(
        'logs',
        logsExport([stringAttr('tool_name', 'Edit'), stringAttr('tool_input', toolInput)])
      );

      const line = spooledLine();
      expect(line).not.toContain(FAKE_SK_OLD);
      expect(line).not.toContain(FAKE_SK_NEW);

      const attributes = spooledAttributes(line);
      expect(attributes.map((a) => a.key)).toEqual(['session.id', 'tool_name', 'tool_input']);
      expect(attributes[1].value).toEqual({ stringValue: 'Edit' });
      const input = JSON.parse(attributes[2].value['stringValue'] as string) as Record<string, string>;
      expect(input['file_path']).toBe('/repo/src/client.ts');
      expect(input['old_string']).toBe('const client = new Client("[REDACTED]");');
      expect(input['new_string']).toBe('const client = new Client("[REDACTED]");');
    });

    it('redacts a secret-named attribute whose value matches no known secret format', async () => {
      const plain = 'correct-horse-battery-staple';
      const res = await postOtlpJson(
        'logs',
        logsExport([stringAttr('tool_name', 'Bash'), stringAttr('api_key', plain), stringAttr('auth_token', plain)])
      );

      expect(res.statusCode).toBe(200);
      const line = spooledLine();
      expect(line).not.toContain(plain);
      expect(spooledAttributes(line)).toEqual([
        stringAttr('session.id', SESSION_ID),
        stringAttr('tool_name', 'Bash'),
        { key: 'api_key', value: { stringValue: '[REDACTED]' } },
        { key: 'auth_token', value: { stringValue: '[REDACTED]' } },
      ]);
    });

    it('does not cut a string over 64 KB: the tail is kept and a secret past the old cap is masked', async () => {
      const filler = 'const answer = compute(42);\n'.repeat(5_000); // ~140 KB
      const newString = `${filler}token = "${FAKE_SK_NEW}"\n${filler}// last line`;
      const toolInput = JSON.stringify({ file_path: '/repo/big.ts', new_string: newString });

      const res = await postOtlpJson('logs', logsExport([stringAttr('tool_input', toolInput)]));

      expect(res.statusCode).toBe(200);
      const line = spooledLine();
      expect(line).not.toContain(FAKE_SK_NEW);
      const input = JSON.parse(spooledAttributes(line)[1].value['stringValue'] as string) as Record<string, string>;
      expect(input['file_path']).toBe('/repo/big.ts');
      expect(input['new_string'].endsWith('// last line')).toBe(true);
      expect(input['new_string'].length).toBeGreaterThan(newString.length - 100);
    });

    it('leaves a secret-free record structurally identical, including typed values', async () => {
      const typed: OtlpAttribute[] = [
        stringAttr('tool_name', 'Read'),
        { key: 'duration_ms', value: { intValue: '42' } },
        { key: 'success', value: { boolValue: true } },
        { key: 'input_tokens', value: { intValue: '1200' } },
      ];
      const body = logsExport(typed);
      await postOtlpJson('logs', body);

      expect(JSON.parse(spooledLine().trim())).toEqual(JSON.parse(body));
    });
  });

  it('routes metrics and traces to their own JSON stream', async () => {
    await postOtlpJson('metrics', JSON.stringify({ sessionId: SESSION_ID }));
    expect(appendSpoolMock.mock.calls[0][1]).toBe('metricsJson');

    appendSpoolMock.mockClear();
    await postOtlpJson('traces', JSON.stringify({ sessionId: SESSION_ID }));
    expect(appendSpoolMock.mock.calls[0][1]).toBe('tracesJson');
  });

  it('drops the record and logs a warning on malformed JSON, without falling through to the byte-blind path', async () => {
    // A session id is still found by regex on the raw bytes, even though the body itself is not valid JSON.
    const res = await postOtlpJson('logs', `not json but has a uuid ${SESSION_ID} in it`);

    expect(res.statusCode).toBe(200);
    expect(appendSpoolMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('drops the record and logs a warning, never spooling the original unmasked bytes, when the spool write itself fails', async () => {
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
