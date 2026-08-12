import { IncomingMessage } from 'http';
import { Readable } from 'stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CopilotEncryptedContentSanitizerPlugin } from '../copilot-encrypted-content-sanitizer.plugin.js';
import type { PluginContext, ProxyInterceptor, UpstreamResponseTools } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const AFFINITY_REJECTION = JSON.stringify({
  error: {
    code: 'invalid_encrypted_content',
    message: 'Encrypted content could not be decrypted or parsed.',
  },
});

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

function createProxyContext(body: unknown, url = '/v1/responses'): ProxyContext {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'copilot-cli',
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'content-length': String(requestBody.length),
    },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function response(statusCode: number): IncomingMessage {
  const stream = Readable.from([]) as IncomingMessage;
  stream.statusCode = statusCode;
  stream.statusMessage = statusCode >= 400 ? 'Bad Request' : 'OK';
  stream.headers = { 'content-type': 'application/json' };
  return stream;
}

function createTools(retryResponse = response(200)): UpstreamResponseTools & {
  retry: ReturnType<typeof vi.fn<[Buffer], Promise<IncomingMessage>>>;
  fromBuffer: ReturnType<typeof vi.fn<[IncomingMessage, Buffer], IncomingMessage>>;
} {
  return {
    readBody: vi.fn(async () => Buffer.from(AFFINITY_REJECTION, 'utf-8')),
    retry: vi.fn(async () => retryResponse),
    fromBuffer: vi.fn((upstream) => upstream),
  };
}

describe('CopilotEncryptedContentSanitizerPlugin', () => {
  let plugin: CopilotEncryptedContentSanitizerPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new CopilotEncryptedContentSanitizerPlugin();
  });

  it('is scoped only to codemie-copilot', async () => {
    await expect(plugin.createInterceptor(createPluginContext('codemie-copilot'))).resolves.toBeDefined();
    await expect(plugin.createInterceptor(createPluginContext('codemie-codex')))
      .rejects.toThrow('Plugin disabled for agent: codemie-codex');
  });

  it('retries Responses API encrypted-content failures once without replayed reasoning state', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(createPluginContext('codemie-copilot'));
    const context = createProxyContext({
      model: 'gpt-5.5-2026-04-24',
      include: ['reasoning.encrypted_content', 'usage'],
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'deployment-bound-state' },
      ],
    });
    const tools = createTools();

    const result = await interceptor.onUpstreamResponse!(context, response(400), tools);

    expect(result.statusCode).toBe(200);
    expect(tools.retry).toHaveBeenCalledTimes(1);
    const retryBody = JSON.parse(tools.retry.mock.calls[0][0].toString('utf-8'));
    expect(retryBody.include).toEqual(['usage']);
    expect(retryBody.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
    expect(context.headers['content-length']).toBe(String(context.requestBody!.length));
  });

  it('returns the original failure body when there is no encrypted-content marker', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(createPluginContext('codemie-copilot'));
    const context = createProxyContext({ input: [{ type: 'reasoning', encrypted_content: 'state' }] });
    const tools = createTools();
    tools.readBody.mockResolvedValue(Buffer.from('{"error":"different"}', 'utf-8'));

    const original = response(400);
    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result).toBe(original);
    expect(tools.retry).not.toHaveBeenCalled();
    expect(tools.fromBuffer).toHaveBeenCalledWith(original, Buffer.from('{"error":"different"}', 'utf-8'));
  });

  it('does not retry non-Responses traffic', async () => {
    const interceptor: ProxyInterceptor = await plugin.createInterceptor(createPluginContext('codemie-copilot'));
    const context = createProxyContext({ input: [{ type: 'reasoning', encrypted_content: 'state' }] }, '/v1/chat/completions');
    const tools = createTools();

    const original = response(400);
    const result = await interceptor.onUpstreamResponse!(context, original, tools);

    expect(result).toBe(original);
    expect(tools.readBody).not.toHaveBeenCalled();
    expect(tools.retry).not.toHaveBeenCalled();
  });
});
