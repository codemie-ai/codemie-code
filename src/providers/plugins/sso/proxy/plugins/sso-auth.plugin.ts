/**
 * SSO Authentication Plugin
 * Priority: 10 (must run first)
 *
 * SOLID: Single responsibility = inject SSO cookies
 * KISS: Simple interceptor, one clear purpose
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { SSOCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';

export class SSOAuthPlugin implements ProxyPlugin {
  id = '@codemie/proxy-sso-auth';
  name = 'SSO Authentication';
  version = '1.0.0';
  priority = 10;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (!context.credentials) {
      throw new Error('SSO credentials required for SSOAuthPlugin');
    }

    return new SSOAuthInterceptor(context.credentials);
  }
}

class SSOAuthInterceptor implements ProxyInterceptor {
  name = 'sso-auth';

  constructor(private credentials: SSOCredentials) {}

  async onRequest(context: ProxyContext): Promise<void> {
    const cookieHeader = Object.entries(this.credentials.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    // Use lowercase 'cookie' to match Node.js HTTP header conventions
    context.headers['cookie'] = cookieHeader;

    logger.debug(`[${this.name}] Injected SSO cookies:`, {
      cookieCount: Object.keys(this.credentials.cookies).length,
      cookieNames: Object.keys(this.credentials.cookies),
      headerLength: cookieHeader.length
    });
  }
}
