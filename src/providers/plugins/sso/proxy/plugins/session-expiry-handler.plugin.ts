import type { IncomingHttpHeaders } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

const SESSION_EXPIRED_STATUS_CODES = new Set([401, 403]);

export class SessionExpiryHandlerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-session-expiry-handler';
  name = 'Session Expiry Handler';
  version = '1.0.0';
  priority = 20;

  async createInterceptor(_context: PluginContext): Promise<ProxyInterceptor> {
    return new SessionExpiryInterceptor();
  }
}

class SessionExpiryInterceptor implements ProxyInterceptor {
  name = 'session-expiry-handler';

  async onResponseHeaders(
    context: ProxyContext,
    _headers: IncomingHttpHeaders
  ): Promise<void> {
    const statusCode = context.metadata.upstreamStatusCode as number | undefined;
    if (statusCode === undefined || !SESSION_EXPIRED_STATUS_CODES.has(statusCode)) {
      return;
    }

    context.metadata.sessionExpired = true;
    logger.warn(
      '[session-expiry-handler] Upstream returned session-expired status — will attempt re-authentication',
      { statusCode, requestId: context.requestId }
    );
  }
}
