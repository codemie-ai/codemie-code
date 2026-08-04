/**
 * VS Code request normalizer plugin tests
 *
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { VsCodeRequestNormalizerPlugin } from '../vscode-request-normalizer.plugin.js';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

interface ProxyContextOptions {
  body?: unknown;
  rawBody?: Buffer | null;
  contentType?: string;
  url?: string;
}

function createPluginContext(clientType?: string): PluginContext {
  return {
    config: {
      targetApiUrl: 'https://api.example.com',
      provider: 'test',
      sessionId: 'test-session',
      clientType,
    },
    logger,
  };
}

function createProxyContext(options: ProxyContextOptions = {}): ProxyContext {
  const requestBody = options.rawBody !== undefined
    ? options.rawBody
    : options.body === undefined
      ? null
      : Buffer.from(JSON.stringify(options.body), 'utf-8');
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  };
  if (requestBody) headers['content-length'] = String(requestBody.length);

  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url: options.url ?? '/v1/responses',
    headers,
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function readBody(context: ProxyContext): Record<string, unknown> {
  return JSON.parse(context.requestBody!.toString('utf-8')) as Record<string, unknown>;
}

describe('VsCodeRequestNormalizerPlugin', () => {
  let plugin: VsCodeRequestNormalizerPlugin;

  beforeEach(() => {
    plugin = new VsCodeRequestNormalizerPlugin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createInterceptor — client scoping', () => {
    it('creates an interceptor only for vscode-byok', async () => {
      const interceptor = await plugin.createInterceptor(createPluginContext('vscode-byok'));

      expect(interceptor.name).toBe('vscode-request-normalizer');
    });

    it.each(['codemie-code', 'codemie-codex', undefined])(
      'rejects non-VS Code client type %s',
      async clientType => {
        await expect(plugin.createInterceptor(createPluginContext(clientType)))
          .rejects.toThrow(`Plugin disabled for agent: ${clientType}`);
      }
    );
  });

  describe('request normalization', () => {
    let interceptor: ProxyInterceptor;

    beforeEach(async () => {
      interceptor = await plugin.createInterceptor(createPluginContext('vscode-byok'));
    });

    it('ignores non-Responses URLs, non-JSON bodies, missing bodies, and invalid JSON', async () => {
      const cases: ProxyContextOptions[] = [
        { url: '/v1/chat/completions', body: {} },
        { contentType: 'text/plain', body: '{}' },
        { rawBody: null },
        { rawBody: Buffer.from('{invalid-json', 'utf-8') },
      ];

      for (const options of cases) {
        const context = createProxyContext(options);
        const originalBody = context.requestBody;
        const originalLength = context.headers['content-length'];

        await interceptor.onRequest!(context);

        expect(context.requestBody).toBe(originalBody);
        expect(context.headers['content-length']).toBe(originalLength);
      }
    });

    it.each([
      ['absent', {}],
      ['empty', { user: '' }],
      ['non-string', { user: 42 }],
    ])('adds the fallback user for an %s field', async (_label, body) => {
      const context = createProxyContext({ body });

      await interceptor.onRequest!(context);

      expect(readBody(context).user).toBe('vscode-byok');
    });

    it.each([
      'short-user',
      'x'.repeat(32),
    ])('preserves an existing user identifier of 32 characters or fewer', async user => {
      const context = createProxyContext({ body: { user } });
      const originalBody = context.requestBody;
      const originalLength = context.headers['content-length'];

      await interceptor.onRequest!(context);

      expect(readBody(context).user).toBe(user);
      expect(context.requestBody).toBe(originalBody);
      expect(context.headers['content-length']).toBe(originalLength);
    });

    it('hashes an overlength identifier to a stable lowercase 32-character digest', async () => {
      const user = 'user-with-more-than-thirty-two-characters';
      const expected = createHash('sha256')
        .update(user, 'utf-8')
        .digest('hex')
        .slice(0, 32);
      const firstContext = createProxyContext({ body: { user } });
      const secondContext = createProxyContext({ body: { user } });

      await interceptor.onRequest!(firstContext);
      await interceptor.onRequest!(secondContext);

      const firstHash = String(readBody(firstContext).user);
      const secondHash = String(readBody(secondContext).user);
      expect(firstHash).toBe(expected);
      expect(firstHash).toBe(secondHash);
      expect(firstHash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces different hashes without logging overlength identifiers', async () => {
      const firstUser = 'first-user-with-more-than-thirty-two-characters';
      const secondUser = 'second-user-with-more-than-thirty-two-characters';
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const firstContext = createProxyContext({ body: { user: firstUser } });
      const secondContext = createProxyContext({ body: { user: secondUser } });

      await interceptor.onRequest!(firstContext);
      await interceptor.onRequest!(secondContext);

      expect(readBody(firstContext).user).not.toBe(readBody(secondContext).user);
      const logText = debugSpy.mock.calls
        .flatMap(call => call.map(argument => String(argument)))
        .join(' ');
      expect(logText).not.toContain(firstUser);
      expect(logText).not.toContain(secondUser);
    });

    it.each([
      '/v1/responses',
      '/proxy/v1/responses?trace=test',
      '/proxy/v1/responses/',
    ])('normalizes Responses URL variants consistently: %s', async url => {
      const context = createProxyContext({ url, body: { model: 'test-model' } });

      await interceptor.onRequest!(context);

      expect(readBody(context).user).toBe('vscode-byok');
    });

    it('updates content-length exactly when the request body changes', async () => {
      const context = createProxyContext({ body: { model: 'test-model', user: '' } });

      await interceptor.onRequest!(context);

      expect(context.headers['content-length']).toBe(String(context.requestBody!.length));
      expect(context.headers['content-length']).toBe(
        String(Buffer.byteLength(context.requestBody!.toString('utf-8'), 'utf-8'))
      );
    });
  });
});
