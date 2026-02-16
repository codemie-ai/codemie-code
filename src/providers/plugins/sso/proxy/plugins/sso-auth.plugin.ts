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
    // Guard: skip if credentials are JWT (not SSO)
    if (!context.credentials || !('cookies' in context.credentials)) {
      return new NoOpInterceptor('sso-auth');
    }

    return new SSOAuthInterceptor(context.credentials as SSOCredentials);
  }
}

/**
 * No-op interceptor returned when this plugin is not the active auth method.
 * Zero runtime cost - no hooks implemented.
 */
class NoOpInterceptor implements ProxyInterceptor {
  constructor(public name: string) {}
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
