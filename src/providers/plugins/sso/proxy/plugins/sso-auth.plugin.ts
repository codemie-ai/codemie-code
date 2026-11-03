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
import { AuthenticationError } from '../proxy-errors.js';
import { CredentialRefresher } from './credential-refresh.js';

export class SSOAuthPlugin implements ProxyPlugin {
  id = '@codemie/proxy-sso-auth';
  name = 'SSO Authentication';
  version = '1.0.0';
  priority = 10;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    // Guard: skip if credentials are JWT (not SSO). `credentialRefresher` may also wrap JWT
    // credentials (the model-catalogue fetch needs it either way), so check the underlying
    // credential type rather than just whether a refresher exists (PR #661 review).
    if (!context.credentials || !('cookies' in context.credentials) || !context.credentialRefresher) {
      return new NoOpInterceptor('sso-auth');
    }

    return new SSOAuthInterceptor(context.credentialRefresher as CredentialRefresher<SSOCredentials>);
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

  constructor(private readonly credentials: CredentialRefresher<SSOCredentials>) {}

  private hasInvalidHeaderChars(value: string): boolean {
    // RFC 7230 field-vchar / obs-text; disallow control chars except HTAB.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if ((code <= 0x1f && code !== 0x09) || code === 0x7f) {
        return true;
      }
    }
    return false;
  }

  async onRequest(context: ProxyContext): Promise<void> {
    const current = await this.credentials.refresh();

    const invalidCookieKeys: string[] = [];
    const cookiePairs: string[] = [];

    for (const [key, value] of Object.entries(current.cookies)) {
      const safeKey = String(key).trim();
      const safeValue = String(value);
      if (!safeKey || this.hasInvalidHeaderChars(safeKey) || this.hasInvalidHeaderChars(safeValue)) {
        invalidCookieKeys.push(safeKey || '<empty>');
        continue;
      }
      cookiePairs.push(`${safeKey}=${safeValue}`);
    }

    if (invalidCookieKeys.length > 0) {
      logger.warn(`[${this.name}] Ignoring invalid cookie entries`, {
        invalidCookieCount: invalidCookieKeys.length,
        invalidCookieNames: invalidCookieKeys,
      });
    }

    if (cookiePairs.length === 0) {
      throw new AuthenticationError(
        'Stored SSO session cookies are invalid. Run `codemie profile login` and reconnect the proxy.'
      );
    }

    const cookieHeader = cookiePairs.join('; ');

    // Use lowercase 'cookie' to match Node.js HTTP header conventions
    context.headers['cookie'] = cookieHeader;

    logger.debug(`[${this.name}] Injected SSO cookies:`, {
      cookieCount: Object.keys(current.cookies).length,
      cookieNames: Object.keys(current.cookies),
      headerLength: cookieHeader.length
    });
  }
}
