/**
 * ProfileModelOverridePlugin tests
 * @group unit
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { logger } from '../../../../../../utils/logger.js';
import type { ProxyContext } from '../../proxy-types.js';
import { ProfileModelOverridePlugin } from '../profile-model-override.plugin.js';
import type { PluginContext, ProxyInterceptor } from '../types.js';

const PROFILE_MODEL = 'profile-model-id';

function createPluginContext(
  enforceProfileModel?: boolean,
  model?: string
): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://upstream.example.com',
      enforceProfileModel,
      model,
    },
    logger,
  };
}

function createRequestContext(
  body: unknown,
  overrides: Partial<ProxyContext> = {}
): ProxyContext {
  const requestBody = typeof body === 'string'
    ? Buffer.from(body, 'utf-8')
    : Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    agentName: 'vscode-byok',
    method: 'POST',
    url: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'content-length': String(requestBody.length),
      'transfer-encoding': 'chunked',
      'Transfer-Encoding': 'chunked',
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function parseBody(context: ProxyContext): Record<string, unknown> {
  return JSON.parse(context.requestBody!.toString('utf-8')) as Record<string, unknown>;
}

describe('ProfileModelOverridePlugin', () => {
  let plugin: ProfileModelOverridePlugin;
  let interceptor: ProxyInterceptor;

  beforeEach(() => {
    plugin = new ProfileModelOverridePlugin();
    interceptor = plugin.createInterceptor(createPluginContext(true, PROFILE_MODEL));
  });

  describe('activation', () => {
    it('has priority 13', () => {
      expect(plugin.priority).toBe(13);
    });

    it.each([
      [undefined, PROFILE_MODEL],
      [false, PROFILE_MODEL],
      [true, undefined],
      [true, '   '],
    ])('is disabled for enforcement=%s and model=%s', (enforcement, model) => {
      expect(() => plugin.createInterceptor(createPluginContext(enforcement, model)))
        .toThrow('Plugin disabled');
    });

    it('is active when enforcement and a model are configured', () => {
      expect(interceptor.name).toBe('profile-model-override');
    });
  });

  describe('Responses API', () => {
    it('replaces only model and updates request metadata and body headers', async () => {
      const original = {
        model: 'codemie-profile-default',
        input: 'Hello',
        instructions: 'Be concise',
        tools: [{ type: 'function', name: 'read_file' }],
        stream: true,
        reasoning: { effort: 'high' },
      };
      const context = createRequestContext(original);

      await interceptor.onRequest!(context);

      expect(parseBody(context)).toEqual({ ...original, model: PROFILE_MODEL });
      expect(context.model).toBe(PROFILE_MODEL);
      expect(context.metadata.originalRequestedModel).toBe('codemie-profile-default');
      expect(context.metadata.profileModelApplied).toBe(true);
      expect(context.headers['content-length']).toBe(String(context.requestBody!.length));
      expect(context.headers['transfer-encoding']).toBeUndefined();
      expect(context.headers['Transfer-Encoding']).toBeUndefined();
    });

    it('populates a missing or empty incoming model', async () => {
      for (const body of [{ input: 'Hello' }, { model: '', input: 'Hello' }]) {
        const context = createRequestContext(body);
        await interceptor.onRequest!(context);
        expect(parseBody(context).model).toBe(PROFILE_MODEL);
      }
    });

    it('preserves Unicode content', async () => {
      const context = createRequestContext({ model: 'logical', input: 'Привет 👋 你好' });

      await interceptor.onRequest!(context);

      expect(parseBody(context).input).toBe('Привет 👋 你好');
    });
  });

  describe('Chat Completions API', () => {
    it('preserves messages, tools, tool choice, streaming, and sampling fields', async () => {
      const original = {
        model: 'codemie-profile-default',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object' } },
        }],
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.2,
        top_p: 0.9,
      };
      const context = createRequestContext(original, { url: '/v1/chat/completions' });

      await interceptor.onRequest!(context);

      expect(parseBody(context)).toEqual({ ...original, model: PROFILE_MODEL });
    });
  });

  describe('request boundaries', () => {
    it('recognizes supported endpoints with query strings', async () => {
      const context = createRequestContext(
        { model: 'logical', input: 'Hello' },
        { url: '/v1/responses?api-version=2026-01-01' }
      );

      await interceptor.onRequest!(context);

      expect(parseBody(context).model).toBe(PROFILE_MODEL);
    });

    it.each(['/v1/messages', '/v1/llm_models', '/health', '/telemetry'])(
      'does not modify unsupported endpoint %s', async (url) => {
        const context = createRequestContext({ model: 'logical' }, { url });
        const original = context.requestBody!.toString('utf-8');

        await interceptor.onRequest!(context);

        expect(context.requestBody!.toString('utf-8')).toBe(original);
      });

    it('does not modify GET requests', async () => {
      const context = createRequestContext({ model: 'logical' }, { method: 'GET' });
      const original = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(original);
    });

    it('does not modify non-JSON requests', async () => {
      const context = createRequestContext(
        { model: 'logical' },
        { headers: { 'content-type': 'text/plain' } }
      );
      const original = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(original);
    });

    it('leaves invalid JSON unchanged without throwing', async () => {
      const context = createRequestContext('{invalid-json');
      const original = context.requestBody!.toString('utf-8');

      await expect(interceptor.onRequest!(context)).resolves.toBeUndefined();
      expect(context.requestBody!.toString('utf-8')).toBe(original);
      expect(context.metadata.profileModelApplied).toBeUndefined();
    });

    it('leaves non-object JSON unchanged', async () => {
      const context = createRequestContext('[]');
      const original = context.requestBody!.toString('utf-8');

      await interceptor.onRequest!(context);

      expect(context.requestBody!.toString('utf-8')).toBe(original);
    });
  });
});
