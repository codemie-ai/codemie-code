import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';

export class GatewayKeyPlugin implements ProxyPlugin {
  id = '@codemie/proxy-gateway-key';
  name = 'Gateway Key Auth';
  version = '1.0.0';
  priority = 7;

  createInterceptor(context: PluginContext): ProxyInterceptor {
    const gatewayKey = context.config.gatewayKey;
    logger.info(
      '[gateway-key] Initializing gateway auth interceptor',
      ...sanitizeLogArgs({
        enabled: Boolean(gatewayKey),
        configuredGatewayKey: gatewayKey,
      })
    );

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

        const authHeader = ctx.headers['authorization'] ?? ctx.headers['Authorization'];
        const expected = `Bearer ${gatewayKey}`;

        logger.info(
          '[gateway-key] Validating incoming gateway authorization header',
          ...sanitizeLogArgs({
            url: ctx.url,
            hasAuthorizationHeader: Boolean(authHeader),
            authorizationHeader: authHeader,
            expectedAuthorizationHeader: expected,
            headerKeys: Object.keys(ctx.headers),
          })
        );

        if (!authHeader || authHeader !== expected) {
          logger.warn(
            '[gateway-key] Rejected request: invalid or missing gateway key',
            ...sanitizeLogArgs({
              url: ctx.url,
              hasAuthorizationHeader: Boolean(authHeader),
              authorizationHeader: authHeader,
              expectedAuthorizationHeader: expected,
            })
          );
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'Invalid API key' },
          }));
          return true;
        }

        delete ctx.headers['authorization'];
        delete ctx.headers['Authorization'];
        ctx.metadata.gatewayKeyValidated = true;
        logger.info(
          '[gateway-key] Gateway key validated and authorization header stripped',
          ...sanitizeLogArgs({
            url: ctx.url,
            remainingHeaderKeys: Object.keys(ctx.headers),
          })
        );
        return false;
      },
    };
  }
}
