/**
 * ModelValueGuardPlugin Tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelValueGuardPlugin } from '../model-value-guard.plugin.js';
import { ClaudeRequestNormalizerPlugin } from '../claude-request-normalizer.plugin.js';
import { BackgroundRequestNormalizerPlugin } from '../background-request-normalizer.plugin.js';
import { CLAUDE_PATH_CLIENTS } from '../../proxy-clients.js';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';
import { MODEL_VALUE_CASES, leakProbe } from '../../../../../../utils/__tests__/model-value-cases.js';
import { describeModelValueViolation, validateModelValue } from '../../../../../../utils/model-value.js';

function makePluginContext(): PluginContext {
  return {
    config: { targetApiUrl: 'https://upstream.example.com' },
    logger,
  };
}

function makeProxyContext(body: string | null, headers: Record<string, string> = {}): ProxyContext {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentName: 'codemie-claude',
    method: 'POST',
    url: '/v1/messages',
    headers,
    requestBody: body === null ? null : Buffer.from(body, 'utf-8'),
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let body = '';
  let statusCode = 200;
  return {
    res: {
      setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
      end: vi.fn((data: string) => { body = data; }),
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
    } as any,
    getBody: () => body,
    getHeaders: () => headers,
    getStatusCode: () => statusCode,
  };
}

describe('ModelValueGuardPlugin', () => {
  let interceptor: ReturnType<ModelValueGuardPlugin['createInterceptor']>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    interceptor = new ModelValueGuardPlugin().createInterceptor(makePluginContext());
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(body: string | null, headers: Record<string, string> = { 'content-type': 'application/json' }) {
    const ctx = makeProxyContext(body, headers);
    const mock = makeMockRes();
    const result = await interceptor.handleRequest!(ctx, {} as any, mock.res, {} as any);
    return { result, ...mock };
  }

  describe('metadata', () => {
    it('sits strictly between the client attribution (8) and the Desktop models answer (9)', () => {
      const plugin = new ModelValueGuardPlugin();
      expect(plugin.id).toBe('@codemie/proxy-model-value-guard');
      expect(plugin.priority).toBe(8.5);
      expect(plugin.clients).toEqual(CLAUDE_PATH_CLIENTS);
    });
  });

  describe.each(MODEL_VALUE_CASES.filter(c => !c.valid))('bad value: $name', row => {
    it('answers 400 in the Anthropic error envelope and leaks nothing', async () => {
      const { result, res, getBody, getHeaders, getStatusCode } = await run(
        JSON.stringify({ model: row.value, messages: [] })
      );
      const violation = validateModelValue(row.value)!;
      const message = describeModelValueViolation(violation);

      expect(result).toBe(true);
      expect(getStatusCode()).toBe(400);
      expect(getHeaders()['Content-Type']).toBe('application/json');
      expect(JSON.parse(getBody())).toEqual({
        type: 'error',
        error: { type: 'invalid_request_error', message },
      });
      expect(res.end).toHaveBeenCalledTimes(1);

      const warned = JSON.stringify(warnSpy.mock.calls);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warned).toContain(violation.rule);
      expect(warned).toContain('codemie-claude');
      expect(warned).toContain(String(violation.length ?? violation.jsonType));

      if (!row.nonText) {
        const probe = leakProbe(row.value as string);
        if (probe) {
          expect(getBody()).not.toContain(probe);
          expect(warned).not.toContain(probe);
        }
      }
    });
  });

  describe.each(MODEL_VALUE_CASES.filter(c => c.valid))('good value: $name', row => {
    it('passes the request through untouched', async () => {
      const { result, res } = await run(JSON.stringify({ model: row.value, messages: [] }));
      expect(result).toBe(false);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('bodies it leaves alone', () => {
    it.each([
      ['no model key', '{"messages":[]}'],
      ['array body', '[{"model":"bad model"}]'],
      ['scalar body', '"bad model"'],
      ['number body', '42'],
      ['unparsable JSON starting with {', '{"model": "bad model"'],
      ['body not starting with {', 'model=bad model'],
      ['empty body', ''],
      ['blank body', '  \n '],
    ])('%s', async (_name, body) => {
      const { result, res } = await run(body);
      expect(result).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
    });

    it('a null request body', async () => {
      const { result, res } = await run(null);
      expect(result).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  describe('bodies it still checks', () => {
    it('rejects a bad model after leading whitespace', async () => {
      const { result, getStatusCode } = await run('  \r\n\t{"model":"bad model"}');
      expect(result).toBe(true);
      expect(getStatusCode()).toBe(400);
    });

    it.each([
      ['text/plain', { 'content-type': 'text/plain' }],
      ['no content-type', {}],
    ])('rejects a bad model under %s', async (_name, headers) => {
      const { result, getStatusCode } = await run('{"model":"bad model"}', headers);
      expect(result).toBe(true);
      expect(getStatusCode()).toBe(400);
    });
  });

  describe('clients', () => {
    it('the normalizers and the guard serve the same Claude-path clients', () => {
      expect(new ClaudeRequestNormalizerPlugin().clients).toEqual(CLAUDE_PATH_CLIENTS);
      expect(new BackgroundRequestNormalizerPlugin().clients).toEqual(CLAUDE_PATH_CLIENTS);
      expect(new ModelValueGuardPlugin().clients).toEqual(CLAUDE_PATH_CLIENTS);
    });

    it('leaves out the other agents', () => {
      expect(CLAUDE_PATH_CLIENTS).not.toContain('codemie-codex');
      expect(CLAUDE_PATH_CLIENTS).not.toContain('codemie-opencode');
    });
  });
});
