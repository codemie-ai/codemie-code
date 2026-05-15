import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';

export class GatewayKeyPlugin implements ProxyPlugin {
  id = '@codemie/proxy-gateway-key';
  name = 'Gateway Key Auth';
  version = '1.0.0';
  priority = 7;

  createInterceptor(context: PluginContext): ProxyInterceptor {
    const gatewayKey = context.config.gatewayKey;

    return {
      name: this.name,

      async handleRequest(
        ctx: ProxyContext,
        _req: IncomingMessage,
        res: ServerResponse,
        _httpClient: ProxyHTTPClient
      ): Promise<boolean> {
        if (!gatewayKey) return false;
        if (ctx.metadata.gatewayKeyValidated) return false;

        const authHeader = ctx.headers['authorization'];
        const expected = `Bearer ${gatewayKey}`;

        if (!authHeader || authHeader !== expected) {
          logger.debug('[gateway-key] Rejected: invalid or missing gateway key');
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'Invalid API key' },
          }));
          return true;
        }

        delete ctx.headers['authorization'];
        ctx.metadata.gatewayKeyValidated = true;
        logger.debug('[gateway-key] Gateway key validated, authorization header stripped');
        return false;
      },
    };
  }
}
