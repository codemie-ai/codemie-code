/**
 * CodeMieProxy streamResponse writes the bytes interceptors still hold once the upstream ends.
 * @group unit
 */
import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeMieProxy } from '../sso.proxy.js';
import { getPluginRegistry, resetPluginRegistry } from '../plugins/registry.js';
import { RoutingHeaderInjectorPlugin } from '../plugins/routing-header-injector.plugin.js';
import type { ProxyInterceptor, ProxyPlugin, ResponseMetadata } from '../plugins/types.js';
import type { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

type StreamResponse = (
  context: ProxyContext,
  upstream: IncomingMessage,
  downstream: ServerResponse,
  startTime: number
) => Promise<ResponseMetadata>;

/** The client side of the proxy: records every write and the end, in order. */
class FakeDownstream extends EventEmitter {
  statusCode = 0;
  events: string[] = [];
  constructor(private readonly closeAfterFirstWrite = false) {
    super();
  }
  setHeader(): void {}
  write(chunk: Buffer): boolean {
    this.events.push(`write:${chunk.toString('utf-8')}`);
    if (this.closeAfterFirstWrite) this.emit('close');
    return true;
  }
  end(): void {
    this.events.push('end');
  }
}

function sseUpstream(chunks: string[], headers: IncomingMessage['headers'] = {}): IncomingMessage {
  const upstream = Readable.from(chunks.map((c) => Buffer.from(c, 'utf-8'))) as IncomingMessage;
  upstream.statusCode = 200;
  upstream.statusMessage = 'OK';
  upstream.headers = { 'content-type': 'text/event-stream', ...headers };
  return upstream;
}

function context(): ProxyContext {
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

/** Runs the injector's upstream hook, which stores the stream's injections in `context.metadata` as the proxy does before streaming. */
async function captureRoutingHeaders(ctx: ProxyContext, upstream: IncomingMessage): Promise<void> {
  const injector = await new RoutingHeaderInjectorPlugin().createInterceptor({
    config: { targetApiUrl: 'http://127.0.0.1:9', provider: 'test' },
    logger,
  });
  await injector.onUpstreamResponse!(ctx, upstream, {
    readBody: async () => Buffer.alloc(0),
    retry: async () => upstream,
    fromBuffer: () => upstream,
  });
}

function plugin(id: string, priority: number, interceptor: Omit<ProxyInterceptor, 'name'>): ProxyPlugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    priority,
    createInterceptor: (): ProxyInterceptor => ({ name: id, ...interceptor }),
  };
}

describe('CodeMieProxy streamResponse end-of-stream step', () => {
  let proxy: CodeMieProxy;

  beforeEach(() => {
    resetPluginRegistry();
  });

  afterEach(async () => {
    await proxy.stop();
    resetPluginRegistry();
  });

  async function start(...plugins: ProxyPlugin[]): Promise<StreamResponse> {
    const registry = getPluginRegistry();
    for (const p of plugins) registry.register(p);
    proxy = new CodeMieProxy({ targetApiUrl: 'http://127.0.0.1:9', host: '127.0.0.1', port: 0, provider: 'test-provider' });
    await proxy.start();
    const internals = proxy as unknown as { streamResponse: StreamResponse };
    return internals.streamResponse.bind(proxy);
  }

  it('writes the held bytes before the downstream ends, in priority order, skipping a throw', async () => {
    const streamResponse = await start(
      plugin('test-late', 20, { onResponseStreamEnd: async () => Buffer.from('held-20', 'utf-8') }),
      plugin('test-throws', 15, {
        onResponseStreamEnd: async () => {
          throw new Error('end hook failed');
        },
      }),
      plugin('test-early', 10, { onResponseStreamEnd: async () => Buffer.from('held-10', 'utf-8') }),
      plugin('test-empty', 5, { onResponseStreamEnd: async () => null })
    );
    const downstream = new FakeDownstream();

    const metadata = await streamResponse(context(), sseUpstream(['data: a\n\n']), downstream as unknown as ServerResponse, Date.now());

    expect(downstream.events).toEqual(['write:data: a\n\n', 'write:held-10', 'write:held-20', 'end']);
    expect(metadata.bytesSent).toBe(23);
  });

  it('keeps the upstream bytes unchanged for interceptors without the step', async () => {
    const streamResponse = await start(
      plugin('test-chunk-only', 10, { onResponseChunk: async (_context, chunk) => chunk })
    );
    const downstream = new FakeDownstream();

    await streamResponse(context(), sseUpstream(['data: a\n', '\ndata: b\n\n']), downstream as unknown as ServerResponse, Date.now());

    expect(downstream.events).toEqual(['write:data: a\n', 'write:\ndata: b\n\n', 'end']);
  });

  it('delivers every upstream byte when the stream ends inside a held line', async () => {
    const streamResponse = await start(new RoutingHeaderInjectorPlugin());
    const ctx = context();
    const chunks = ['event: message_start\n', 'data: {"type":"message_st', 'art","mess'];
    const upstream = sseUpstream(chunks, { 'x-litellm-model-name': 'bedrock/eu.anthropic.claude-opus-5-5' });
    await captureRoutingHeaders(ctx, upstream);
    const downstream = new FakeDownstream();

    const metadata = await streamResponse(ctx, upstream, downstream as unknown as ServerResponse, Date.now());

    const written = downstream.events.filter((e) => e.startsWith('write:')).map((e) => e.slice(6)).join('');
    expect(written).toBe(chunks.join(''));
    expect(downstream.events.at(-1)).toBe('end');
    expect(metadata.bytesSent).toBe(Buffer.byteLength(chunks.join('')));
  });

  it('writes the held bytes when the upstream fails, then rejects with its error', async () => {
    const streamResponse = await start(new RoutingHeaderInjectorPlugin());
    const ctx = context();
    const chunks = ['event: message_start\n', 'data: {"type":"message_st'];
    const failure = new Error('upstream reset');
    async function* failingBody(): AsyncGenerator<Buffer> {
      for (const c of chunks) yield Buffer.from(c, 'utf-8');
      throw failure;
    }
    const upstream = Readable.from(failingBody()) as IncomingMessage;
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'text/event-stream', 'x-litellm-model-name': 'bedrock/eu.anthropic.claude-opus-5-5' };
    await captureRoutingHeaders(ctx, upstream);
    const downstream = new FakeDownstream();

    await expect(streamResponse(ctx, upstream, downstream as unknown as ServerResponse, Date.now())).rejects.toBe(failure);

    const written = downstream.events.filter((e) => e.startsWith('write:')).map((e) => e.slice(6)).join('');
    expect(written).toBe('event: message_start\ndata: {"type":"message_st');
  });

  it('writes nothing held once the downstream has closed', async () => {
    const streamResponse = await start(new RoutingHeaderInjectorPlugin());
    const ctx = context();
    const upstream = sseUpstream(
      ['event: message_start\ndata: {"type":"message_st', 'art"}'],
      { 'x-litellm-model-name': 'bedrock/eu.anthropic.claude-opus-5-5' }
    );
    await captureRoutingHeaders(ctx, upstream);
    const downstream = new FakeDownstream(true);

    const metadata = await streamResponse(ctx, upstream, downstream as unknown as ServerResponse, Date.now());

    expect(downstream.events).toEqual(['write:event: message_start\n', 'end']);
    expect(metadata.bytesSent).toBe(21);
  });
});
