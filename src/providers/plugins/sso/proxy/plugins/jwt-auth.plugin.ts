/**
 * JWT Authentication Plugin
 * Priority: 10 (same as SSO - only one activates based on credential type)
 *
 * SOLID: Single responsibility = inject JWT bearer token
 * KISS: Simple interceptor, one clear purpose
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { JWTCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';

export class JWTAuthPlugin implements ProxyPlugin {
  id = '@codemie/proxy-jwt-auth';
  name = 'JWT Authentication';
  version = '1.0.0';
  priority = 10;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    // Guard: skip if credentials are not JWT (mutual exclusion with SSOAuthPlugin)
    if (!context.credentials || !('token' in context.credentials)) {
      return new NoOpInterceptor('jwt-auth');
    }

    return new JWTAuthInterceptor(context.credentials as JWTCredentials);
  }
}

/**
 * No-op interceptor returned when this plugin is not the active auth method.
 * Zero runtime cost - no hooks implemented.
 */
class NoOpInterceptor implements ProxyInterceptor {
  constructor(public name: string) {}
}

class JWTAuthInterceptor implements ProxyInterceptor {
  name = 'jwt-auth';

  constructor(private credentials: JWTCredentials) {}

  async onRequest(context: ProxyContext): Promise<void> {
    // Check token expiration
    if (this.credentials.expiresAt && Date.now() > this.credentials.expiresAt) {
      throw new Error('JWT token expired. Please re-authenticate.');
    }

    // Inject Bearer token into Authorization header
    context.headers['authorization'] = `Bearer ${this.credentials.token}`;

    logger.debug(`[${this.name}] Injected JWT bearer token`, {
      tokenPrefix: this.credentials.token.substring(0, 20) + '...',
      expiresAt: this.credentials.expiresAt
        ? new Date(this.credentials.expiresAt).toISOString()
        : 'no expiration'
    });
  }
}
