import { IncomingHttpHeaders, IncomingMessage } from 'http';
import { Readable } from 'stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'zlib';
import { describe, it, expect } from 'vitest';
import {
  extractRoutingHeaders,
  injectIntoJsonBody,
  injectIntoSseChunk,
  MAX_HELD_TAIL_BYTES,
  RoutingHeaderInjectorPlugin,
} from '../routing-header-injector.plugin.js';
import type { ProxyInterceptor, UpstreamResponseTools } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

const ROUTE = 'bedrock/eu.anthropic.claude-opus-5-5';
const ROUTE_FIELD = `"x-litellm-model-name":"${ROUTE}"`;

function proxyContext(): ProxyContext {
  return {
    requestId: 'test-req',
    sessionId: 'test-session',
    agentName: 'claude',
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: {},
  };
}

function upstream(headers: IncomingHttpHeaders, body: Buffer = Buffer.alloc(0)): IncomingMessage {
  const stream = Readable.from([body]) as IncomingMessage;
  stream.statusCode = 200;
  stream.statusMessage = 'OK';
  stream.headers = headers;
  return stream;
}

/** Mirrors the proxy's tools: reads the body bytes and rebuilds a response the way `createBufferedResponse` does. */
function tools(): UpstreamResponseTools {
  return {
    readBody: async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
    retry: async () => {
      throw new Error('retry is not expected');
    },
    fromBuffer: (source, body) => {
      const rebuilt = Readable.from([body]) as IncomingMessage;
      rebuilt.statusCode = source.statusCode;
      rebuilt.statusMessage = source.statusMessage;
      rebuilt.headers = { ...source.headers, 'content-length': String(body.length) };
      return rebuilt;
    },
  };
}

async function readAll(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function interceptor(): Promise<ProxyInterceptor> {
  return new RoutingHeaderInjectorPlugin().createInterceptor({
    config: { targetApiUrl: 'https://api.example.com', provider: 'test' },
    logger,
  });
}

const SSE_HEADERS: IncomingHttpHeaders = {
  'content-type': 'text/event-stream',
  'x-litellm-model-name': ROUTE,
};

/** Opens a stream through `onUpstreamResponse`, so the interceptor stores its injections the way the proxy drives it. */
async function openStream(
  target: ProxyInterceptor,
  headers: IncomingHttpHeaders = SSE_HEADERS
): Promise<ProxyContext> {
  const context = proxyContext();
  await target.onUpstreamResponse!(context, upstream(headers), tools());
  return context;
}

/** Drives the chunks and the end-of-stream step; returns each chunk call's result and the client bytes. */
async function stream(
  target: ProxyInterceptor,
  context: ProxyContext,
  chunks: Buffer[]
): Promise<{ returned: Array<Buffer | null>; client: Buffer }> {
  const returned: Array<Buffer | null> = [];
  for (const chunk of chunks) returned.push(await target.onResponseChunk!(context, chunk));
  const held = await target.onResponseStreamEnd!(context);
  const written = [...returned, held].filter((b): b is Buffer => b !== null);
  return { returned, client: Buffer.concat(written) };
}

/** A `message_start` data line of exactly `length` bytes, padded through its id. */
function messageStartLine(length: number, model = 'claude-opus-5-5'): string {
  const build = (id: string) =>
    'data: ' +
    JSON.stringify({
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 12 } },
    });
  const base = build('msg_');
  return build('msg_' + 'x'.repeat(length - base.length));
}

const MESSAGE_START = messageStartLine(508);
const PREFIX = 'event: message_start\n';
const AFTER = 'event: ping\ndata: {"type": "ping"}\n\nevent: content_block_start\n';
const WHOLE = Buffer.from(PREFIX + MESSAGE_START + '\n\n' + AFTER, 'utf-8');
const WHOLE_REWRITE = injectIntoSseChunk(WHOLE, { 'x-litellm-model-name': ROUTE });

function splitAt(buffer: Buffer, ...offsets: number[]): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (const offset of offsets) {
    parts.push(buffer.subarray(start, offset));
    start = offset;
  }
  parts.push(buffer.subarray(start));
  return parts;
}

describe('RoutingHeaderInjectorPlugin', () => {
  describe('extractRoutingHeaders', () => {
    it('captures x-litellm-* headers with hyphens intact', () => {
      const headers = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-router-cause': 'llm_classifier',
        'x-litellm-model-name': 'claude-sonnet-5',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-router-cause': 'llm_classifier',
        'x-litellm-model-name': 'claude-sonnet-5',
      });
    });

    it('captures x-codemie-routing-* and x-codemie-requested-* headers with hyphens intact', () => {
      const headers = {
        'x-codemie-routing-tier': 'efficient',
        'x-codemie-routing-source': 'judge',
        'x-codemie-requested-model': 'claude-sonnet-4-6',
        'x-codemie-routing-classifier-cost-usd': '0.002475',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-codemie-routing-tier': 'efficient',
        'x-codemie-routing-source': 'judge',
        'x-codemie-requested-model': 'claude-sonnet-4-6',
        'x-codemie-routing-classifier-cost-usd': '0.002475',
      });
    });

    it('ignores non-routing headers', () => {
      const headers = {
        'authorization': 'Bearer secret-token',
        'content-type': 'application/json',
        'x-custom-header': 'value',
        'x-litellm-router-tier': 'SIMPLE',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'SIMPLE',
      });
    });

    it('handles array-valued headers by taking the first element', () => {
      const headers = {
        'x-litellm-router-signals': ['["llm-classifier:COMPLEX"]', 'ignored'],
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-signals': '["llm-classifier:COMPLEX"]',
      });
    });

    it('ignores null and undefined values', () => {
      const headers = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-missing': null as unknown as string,
        'x-codemie-routing-tier': undefined as unknown as string,
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'COMPLEX',
      });
    });

    it('returns empty object when no routing headers are present', () => {
      const headers = {
        'authorization': 'Bearer token',
        'content-type': 'application/json',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({});
    });

    it('case-insensitive matching for header names', () => {
      const headers = {
        'X-LiteLLM-Router-Tier': 'COMPLEX',
        'X-CodeMie-Routing-Tier': 'efficient',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'COMPLEX',
        'x-codemie-routing-tier': 'efficient',
      });
    });
  });

  describe('injectIntoJsonBody', () => {
    it('merges injections into a JSON object', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_123', role: 'assistant', content: [] }));
      const injections = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      };
      const result = injectIntoJsonBody(body, injections);
      const parsed = JSON.parse(result.toString('utf-8'));
      expect(parsed).toEqual({
        id: 'msg_123',
        role: 'assistant',
        content: [],
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      });
    });

    it('returns original buffer when injections are empty', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_123' }));
      const result = injectIntoJsonBody(body, {});
      expect(result).toBe(body);
    });

    it('returns original buffer when body is not a JSON object', () => {
      const testCases = [
        Buffer.from('not json'),
        Buffer.from('[]'),
        Buffer.from('null'),
        Buffer.from('123'),
        Buffer.from('true'),
      ];
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      for (const body of testCases) {
        const result = injectIntoJsonBody(body, injections);
        expect(result).toBe(body);
      }
    });

    it('returns original buffer on parse error', () => {
      const body = Buffer.from('{broken json}');
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoJsonBody(body, injections);
      expect(result).toBe(body);
    });

    it('overwrites existing keys if injections have the same key', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_123', 'x-litellm-router-tier': 'old' }));
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoJsonBody(body, injections);
      const parsed = JSON.parse(result.toString('utf-8'));
      expect(parsed['x-litellm-router-tier']).toBe('COMPLEX');
    });
  });

  describe('injectIntoSseChunk', () => {
    it('injects fields into the message object of a message_start event', () => {
      const chunk = Buffer.from(
        'data: ' +
          JSON.stringify({
            type: 'message_start',
            message: { id: 'msg_123', role: 'assistant', model: 'claude-sonnet-5' },
          })
      );
      const injections = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      };
      const result = injectIntoSseChunk(chunk, injections);
      const line = result.toString('utf-8');
      const parsed = JSON.parse(line.slice(6));
      expect(parsed.message).toEqual({
        id: 'msg_123',
        role: 'assistant',
        model: 'claude-sonnet-5',
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      });
    });

    it('preserves non-message_start events unchanged', () => {
      const chunk = Buffer.from(
        'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta' } })
      );
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('preserves non-JSON lines unchanged', () => {
      const chunk = Buffer.from('data: [DONE]');
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('preserves other event types in a multi-line chunk', () => {
      const multiLine = `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1' } })}
data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}
data: [DONE]`;
      const chunk = Buffer.from(multiLine);
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      const lines = result.toString('utf-8').split('\n');
      // First line should be modified, others unchanged
      expect(JSON.parse(lines[0].slice(6)).message['x-litellm-router-tier']).toBe('COMPLEX');
      expect(lines[1]).toBe(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}`
      );
      expect(lines[2]).toBe('data: [DONE]');
    });

    it('returns original buffer when injections are empty', () => {
      const chunk = Buffer.from(
        'data: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_123' } })
      );
      const result = injectIntoSseChunk(chunk, {});
      expect(result).toBe(chunk);
    });

    it('returns original buffer when no message_start is present', () => {
      const chunk = Buffer.from('data: ' + JSON.stringify({ type: 'content_block_delta' }));
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('handles partial lines gracefully (does not parse or modify)', () => {
      const chunk = Buffer.from('data: {"type":"message_st');
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('injects into all message_start events in a multi-line chunk', () => {
      const multiStart = `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1' } })}
data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2' } })}`;
      const chunk = Buffer.from(multiStart);
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      const lines = result.toString('utf-8').split('\n');
      // Both get injected (both are message_start events)
      expect(JSON.parse(lines[0].slice(6)).message['x-litellm-router-tier']).toBe('COMPLEX');
      expect(JSON.parse(lines[1].slice(6)).message['x-litellm-router-tier']).toBe('COMPLEX');
    });
  });

  describe('interceptor: SSE stream', () => {
    it('rewrites a message_start line that arrives whole in the first chunk', async () => {
      const target = await interceptor();
      const context = await openStream(target);

      const { client } = await stream(target, context, [WHOLE]);

      expect(MESSAGE_START.length).toBe(508);
      expect(client.equals(WHOLE_REWRITE)).toBe(true);
      const line = client.toString('utf-8').split('\n')[1];
      expect(JSON.parse(line.slice(6)).message['x-litellm-model-name']).toBe(ROUTE);
      expect(line).toContain(ROUTE_FIELD);
    });

    it('rewrites a message_start line cut after byte 221 by a chunk boundary', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const cut = Buffer.byteLength(PREFIX) + 221;

      const { returned, client } = await stream(target, context, splitAt(WHOLE, cut));

      expect(returned[0]?.toString('utf-8')).toBe(PREFIX);
      expect(client.equals(WHOLE_REWRITE)).toBe(true);
      expect(client.toString('utf-8')).toContain('"x-litellm-model-name":"bedrock/eu.anthropic.claude-opus-5-5"');
    });

    it('rewrites a message_start line cut into three chunks', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const start = Buffer.byteLength(PREFIX);

      const { client } = await stream(target, context, splitAt(WHOLE, start + 100, start + 400));

      expect(client.equals(WHOLE_REWRITE)).toBe(true);
      expect(client.toString('utf-8')).toContain('"x-litellm-model-name":"bedrock/eu.anthropic.claude-opus-5-5"');
    });

    it('rewrites a message_start line that comes after a first ping line', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const chunks = [
        Buffer.from('event: ping\ndata: {"type":"ping"}\n\n', 'utf-8'),
        Buffer.from('event: ping\ndata: {"type":"ping"}\n\n', 'utf-8'),
        Buffer.from(PREFIX + MESSAGE_START + '\n\n', 'utf-8'),
        Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n', 'utf-8'),
      ];

      const { returned } = await stream(target, context, chunks);

      expect(returned[0]).toBe(chunks[0]);
      expect(returned[1]).toBe(chunks[1]);
      expect(returned[2]?.toString('utf-8')).toContain('"x-litellm-model-name":"bedrock/eu.anthropic.claude-opus-5-5"');
      expect(returned[3]).toBe(chunks[3]);
    });

    it('passes a compressed stream chunk by chunk, nothing held', async () => {
      const target = await interceptor();
      const context = await openStream(target, { ...SSE_HEADERS, 'content-encoding': 'gzip' });
      const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x0a, 0x41, 0x42]), Buffer.from([0x43, 0x0a, 0x44, 0x45])];

      expect(await target.onResponseChunk!(context, chunks[0])).toBe(chunks[0]);
      expect(await target.onResponseChunk!(context, chunks[1])).toBe(chunks[1]);
      expect(await target.onResponseStreamEnd!(context)).toBeNull();
    });

    it('keeps a stream without a routing header byte for byte, nothing held', async () => {
      const target = await interceptor();
      const context = await openStream(target, { 'content-type': 'text/event-stream' });
      const chunks = splitAt(WHOLE, 30);

      const { returned } = await stream(target, context, chunks);

      expect(returned[0]).toBe(chunks[0]);
      expect(returned[1]).toBe(chunks[1]);
      expect(await target.onResponseStreamEnd!(context)).toBeNull();
    });

    it('delivers exactly the upstream bytes when the stream ends inside the first data line', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const upstreamBytes = Buffer.from(PREFIX + MESSAGE_START.slice(0, 300), 'utf-8');

      const { client } = await stream(target, context, splitAt(upstreamBytes, 100));

      expect(client.equals(upstreamBytes)).toBe(true);
    });

    it('keeps the \\r\\n ending of a split message_start line', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const crlf = Buffer.from(PREFIX.replace('\n', '\r\n') + MESSAGE_START + '\r\n\r\n', 'utf-8');

      const { client } = await stream(target, context, splitAt(crlf, 250));

      const lines = client.toString('utf-8').split('\n');
      expect(lines[0]).toBe('event: message_start\r');
      expect(lines[1]).toContain(ROUTE_FIELD);
      expect(lines[1].endsWith('}\r')).toBe(true);
      expect(lines.slice(2)).toEqual(['\r', '']);
    });

    it('rewrites a line whose multi-byte character is cut by a chunk boundary', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const line = messageStartLine(508, 'модель-日本');
      const whole = Buffer.from(PREFIX + line + '\n\n', 'utf-8');
      const charStart = whole.indexOf(Buffer.from('日', 'utf-8'));

      const { client } = await stream(target, context, splitAt(whole, charStart + 1));

      expect(client.equals(injectIntoSseChunk(whole, { 'x-litellm-model-name': ROUTE }))).toBe(true);
      expect(client.toString('utf-8')).toContain('модель-日本');
    });

    it('gives up when an unfinished line grows past MAX_HELD_TAIL_BYTES', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      const first = Buffer.from('data: {"pad":"' + 'a'.repeat(40000), 'utf-8');
      const second = Buffer.from('b'.repeat(30000), 'utf-8');
      const third = Buffer.from('"}\n\n', 'utf-8');

      const { returned, client } = await stream(target, context, [first, second, third]);

      expect(MAX_HELD_TAIL_BYTES).toBe(65536);
      expect(returned[0]).toBeNull();
      expect(returned[1]?.equals(Buffer.concat([first, second]))).toBe(true);
      expect(returned[2]).toBe(third);
      expect(client.equals(Buffer.concat([first, second, third]))).toBe(true);
    });

    it('passes a second message_start unchanged after the first rewrite', async () => {
      const target = await interceptor();
      const context = await openStream(target);
      await target.onResponseChunk!(context, WHOLE);
      const second = Buffer.from(MESSAGE_START + '\n\n', 'utf-8');

      expect(await target.onResponseChunk!(context, second)).toBe(second);
    });

    it.each([
      ['whole', [] as number[]],
      ['split', [20]],
    ])('holds nothing after a first data line that is not message_start (%s)', async (_label, offsets) => {
      const target = await interceptor();
      const context = await openStream(target);
      const first = Buffer.from('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"A"}}]}\n\ndata: {"id"', 'utf-8');
      const later = [Buffer.from(':"chatcmpl-1","choices":[]}\n\n', 'utf-8'), Buffer.from('data: [DONE]\n\n', 'utf-8')];
      const firstParts = splitAt(first, ...offsets);

      const { returned, client } = await stream(target, context, [...firstParts, ...later]);

      expect(returned.at(-2)).toBe(later[0]);
      expect(returned.at(-1)).toBe(later[1]);
      expect(client.equals(Buffer.concat([first, ...later]))).toBe(true);
    });

    it('keeps a separate held tail for each of two concurrent streams', async () => {
      const target = await interceptor();
      const contextA = await openStream(target);
      const contextB = await openStream(target, { ...SSE_HEADERS, 'x-litellm-model-name': 'vertex_ai/claude-sonnet-4-6' });
      const [a1, a2] = splitAt(WHOLE, 200);
      const [b1, b2] = splitAt(WHOLE, 300);

      const out = { a: [] as Array<Buffer | null>, b: [] as Array<Buffer | null> };
      out.a.push(await target.onResponseChunk!(contextA, a1));
      out.b.push(await target.onResponseChunk!(contextB, b1));
      out.a.push(await target.onResponseChunk!(contextA, a2));
      out.b.push(await target.onResponseChunk!(contextB, b2));
      out.a.push(await target.onResponseStreamEnd!(contextA));
      out.b.push(await target.onResponseStreamEnd!(contextB));

      const join = (parts: Array<Buffer | null>) => Buffer.concat(parts.filter((b): b is Buffer => b !== null));
      expect(join(out.a).equals(WHOLE_REWRITE)).toBe(true);
      expect(
        join(out.b).equals(injectIntoSseChunk(WHOLE, { 'x-litellm-model-name': 'vertex_ai/claude-sonnet-4-6' }))
      ).toBe(true);
    });
  });

  describe('interceptor: JSON answer', () => {
    const MESSAGE = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    const JSON_HEADERS: IncomingHttpHeaders = {
      'content-type': 'application/json',
      'x-litellm-model-name': ROUTE,
    };

    it.each([
      ['br', brotliCompressSync],
      ['gzip', gzipSync],
      ['x-gzip', gzipSync],
      ['deflate', deflateSync],
    ])('sends a %s JSON object answer uncompressed with the route marker', async (encoding, compress) => {
      const target = await interceptor();
      const compressed = compress(Buffer.from(JSON.stringify(MESSAGE), 'utf-8'));
      const response = upstream({ ...JSON_HEADERS, 'content-encoding': encoding }, compressed);

      const result = await target.onUpstreamResponse!(proxyContext(), response, tools());

      const body = await readAll(result);
      expect(JSON.parse(body.toString('utf-8'))).toEqual({ ...MESSAGE, 'x-litellm-model-name': ROUTE });
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['content-length']).toBe(String(body.length));
    });

    it('keeps a plain JSON object answer rewritten as injectIntoJsonBody does', async () => {
      const target = await interceptor();
      const plain = Buffer.from(JSON.stringify(MESSAGE), 'utf-8');

      const result = await target.onUpstreamResponse!(proxyContext(), upstream(JSON_HEADERS, plain), tools());

      const body = await readAll(result);
      expect(body.equals(injectIntoJsonBody(plain, { 'x-litellm-model-name': ROUTE }))).toBe(true);
      expect(result.headers).toEqual({ ...JSON_HEADERS, 'content-length': String(body.length) });
    });

    it.each([
      ['br', Buffer.from('not brotli at all', 'utf-8')],
      ['zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])],
      ['gzip', gzipSync(Buffer.from('[{"id":"msg_1"}]', 'utf-8'))],
    ])('passes a %s answer it cannot rewrite with its body and headers as received', async (encoding, raw) => {
      const target = await interceptor();
      const headers = { ...JSON_HEADERS, 'content-encoding': encoding };

      const result = await target.onUpstreamResponse!(proxyContext(), upstream(headers, raw), tools());

      const body = await readAll(result);
      expect(body.equals(raw)).toBe(true);
      expect(result.headers).toEqual({ ...headers, 'content-length': String(raw.length) });
      expect(result.headers['content-encoding']).toBe(encoding);
    });

    it('rewrites a JSON answer with content-encoding identity as a plain one', async () => {
      const target = await interceptor();
      const plain = Buffer.from(JSON.stringify(MESSAGE), 'utf-8');
      const response = upstream({ ...JSON_HEADERS, 'content-encoding': 'identity' }, plain);

      const result = await target.onUpstreamResponse!(proxyContext(), response, tools());

      const body = await readAll(result);
      expect(JSON.parse(body.toString('utf-8'))).toEqual({ ...MESSAGE, 'x-litellm-model-name': ROUTE });
      expect(result.headers['content-encoding']).toBe('identity');
      expect(result.headers['content-length']).toBe(String(body.length));
    });

    it('passes a gzip answer that decompresses past 16 MiB as received', async () => {
      const target = await interceptor();
      const raw = gzipSync(Buffer.from(JSON.stringify({ pad: 'a'.repeat(16 * 1024 * 1024) }), 'utf-8'));
      const headers = { ...JSON_HEADERS, 'content-encoding': 'gzip' };

      const result = await target.onUpstreamResponse!(proxyContext(), upstream(headers, raw), tools());

      const body = await readAll(result);
      expect(body.equals(raw)).toBe(true);
      expect(result.headers).toEqual({ ...headers, 'content-length': String(raw.length) });
      expect(result.headers['content-encoding']).toBe('gzip');
    });

    it('sends the original body when the injection throws after the body was read', async () => {
      const target = await interceptor();
      const plain = Buffer.from(JSON.stringify(MESSAGE), 'utf-8');
      const proxyTools = tools();
      const fromBuffer = proxyTools.fromBuffer;
      let failed = false;
      proxyTools.fromBuffer = (source, body) => {
        if (!failed) {
          failed = true;
          throw new Error('rebuild failed');
        }
        return fromBuffer(source, body);
      };

      const result = await target.onUpstreamResponse!(proxyContext(), upstream(JSON_HEADERS, plain), proxyTools);

      expect((await readAll(result)).equals(plain)).toBe(true);
    });
  });
});
