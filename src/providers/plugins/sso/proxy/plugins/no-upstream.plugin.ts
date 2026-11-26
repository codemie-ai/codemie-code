/**
 * The last plugin of a daemon with no upstream: a request no earlier plugin answered gets 404 here, so the proxy core
 * never builds a target URL for it.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';

export class NoUpstreamPlugin implements ProxyPlugin {
  id = '@codemie/no-upstream';
  name = 'No Upstream';
  version = '1.0.0';
  /** After every other plugin's. */
  priority = 1000;

  createInterceptor(): ProxyInterceptor {
    return {
      name: 'no-upstream',
      async handleRequest(
        _ctx: ProxyContext,
        _req: IncomingMessage,
        res: ServerResponse,
        _httpClient: ProxyHTTPClient
      ): Promise<boolean> {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'This proxy has no upstream' } }));
        return true;
      },
    };
  }
}
