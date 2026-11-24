/**
 * The logging plugin keeps what it collects of a response in that request's context: requests streamed at the same
 * time each report their own chunks and bytes. Its output, the debug log, is read through a spy.
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoggingPlugin } from '../logging.plugin.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

function context(requestId: string): ProxyContext {
  return {
    requestId, sessionId: 's1', agentName: 'codex-desktop', method: 'POST', url: '/v1/responses',
    headers: { 'content-type': 'application/json' }, requestBody: null, requestStartTime: 0, metadata: {},
  };
}

const complete = { statusCode: 200, statusMessage: 'OK', headers: {}, bytesSent: 0, durationMs: 1 };

afterEach(() => vi.restoreAllMocks());

describe('LoggingPlugin', () => {
  it('two interleaved requests each report their own chunk count and bytes', async () => {
    const debug = vi.spyOn(logger, 'debug');
    const interceptor = await new LoggingPlugin().createInterceptor({ config: { targetApiUrl: 'http://127.0.0.1:9' }, logger });
    const first = context('first');
    const second = context('second');
    await interceptor.onRequest!(first);
    await interceptor.onRequest!(second);
    await interceptor.onResponseHeaders!(first, { 'content-type': 'text/event-stream' });
    await interceptor.onResponseChunk!(first, Buffer.from('aaa'));
    await interceptor.onResponseHeaders!(second, { 'content-type': 'application/json' });
    await interceptor.onResponseChunk!(second, Buffer.from('bbbbbbb'));
    await interceptor.onResponseChunk!(first, Buffer.from('aa'));

    await interceptor.onResponseComplete!(second, complete);
    await interceptor.onResponseComplete!(first, complete);
    // The response is logged on the next turn of the event loop
    await new Promise((resolve) => setImmediate(resolve));

    const reported = debug.mock.calls
      .filter(([message]) => String(message).startsWith('[proxy-response]'))
      .map(([, meta]) => meta as { requestId: string; totalChunks: number; totalBytesStreamed: number; contentType: string });
    expect(reported.map(({ requestId, totalChunks, totalBytesStreamed, contentType }) => ({ requestId, totalChunks, totalBytesStreamed, contentType })))
      .toEqual([
        { requestId: 'second', totalChunks: 1, totalBytesStreamed: 7, contentType: 'application/json' },
        { requestId: 'first', totalChunks: 2, totalBytesStreamed: 5, contentType: 'text/event-stream' },
      ]);
  });
});
