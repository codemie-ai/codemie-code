/**
 * SSO proxy response handling tests.
 * @group unit
 */

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { PluginContext, UpstreamResponseTools } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import type { SSOCredentials } from '../../../../../core/types.js';
import { SSOAuthPlugin } from '../sso-auth.plugin.js';

const { markAnalyticsAuthInvalid } = vi.hoisted(() => ({
  markAnalyticsAuthInvalid: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../../utils/analytics-auth-status.js', () => ({
  markAnalyticsAuthInvalid,
}));

vi.mock('../../../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeResponse(statusCode: number, contentType: string): IncomingMessage {
  const response = Readable.from([Buffer.from('<html>login</html>')]) as unknown as IncomingMessage;
  response.statusCode = statusCode;
  response.statusMessage = statusCode === 200 ? 'OK' : 'Unauthorized';
  response.headers = { 'content-type': contentType };
  return response;
}

function makeTools(): UpstreamResponseTools {
  return {
    readBody: vi.fn(async () => Buffer.alloc(0)),
    retry: vi.fn(),
    fromBuffer: vi.fn((source: IncomingMessage, body: Buffer) => {
      const response = Readable.from(body) as unknown as IncomingMessage;
      response.statusCode = source.statusCode;
      response.statusMessage = source.statusMessage;
      response.headers = { ...source.headers };
      return response;
    }),
  };
}

function makeContext(): ProxyContext {
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    agentName: 'opencode',
    method: 'POST',
    url: '/responses',
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    targetUrl: 'https://api.example.com/responses',
    metadata: {},
  };
}

function makeCredentials(): SSOCredentials {
  return {
    cookies: { session: 'expired' },
    apiUrl: 'https://api.example.com',
  };
}

function makePluginContext(credentials: SSOCredentials): PluginContext {
  return {
    config: { targetApiUrl: credentials.apiUrl, provider: 'ai-run-sso' },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    } as never,
    credentials,
  };
}

async function readBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('SSOAuthPlugin upstream response handling', () => {
  it.each([
    [401, 'application/json'],
    [403, 'application/json'],
    [200, 'text/html; charset=utf-8'],
  ])('converts HTTP %s authentication responses into a structured 401', async (statusCode, contentType) => {
    const plugin = new SSOAuthPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext(makeCredentials()));
    const response = await interceptor.onUpstreamResponse!(
      makeContext(),
      makeResponse(statusCode, contentType),
      makeTools(),
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(await readBody(response))).toMatchObject({
      error: {
        type: 'authentication_error',
        code: 'AUTH_FAILED',
      },
    });
    expect(markAnalyticsAuthInvalid).toHaveBeenCalledWith(
      expect.any(String),
      'https://api.example.com',
    );
  });

  it('leaves a valid JSON model response unchanged', async () => {
    const plugin = new SSOAuthPlugin();
    const interceptor = await plugin.createInterceptor(makePluginContext(makeCredentials()));
    const response = makeResponse(200, 'application/json');

    await expect(
      interceptor.onUpstreamResponse!(makeContext(), response, makeTools()),
    ).resolves.toBe(response);
  });
});
