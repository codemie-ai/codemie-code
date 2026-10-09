/**
 * SSO Authentication Plugin
 * Priority: 10 (must run first)
 *
 * SOLID: Single responsibility = inject SSO cookies
 * KISS: Simple interceptor, one clear purpose
 */

import { IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { SSOCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';
import { AuthenticationError } from '../proxy-errors.js';
import { markAnalyticsAuthInvalid } from '../../../../../utils/analytics-auth-status.js';

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
    const invalidCookieKeys: string[] = [];
    const cookiePairs: string[] = [];

    for (const [key, value] of Object.entries(this.credentials.cookies)) {
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
      cookieCount: Object.keys(this.credentials.cookies).length,
      cookieNames: Object.keys(this.credentials.cookies),
      headerLength: cookieHeader.length
    });
  }

  async onUpstreamResponse(
    context: ProxyContext,
    response: IncomingMessage,
    tools: UpstreamResponseTools,
  ): Promise<IncomingMessage> {
    const statusCode = response.statusCode || 0;
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const isHtmlLoginPage = statusCode >= 200 && statusCode < 300 && contentType.includes('text/html');
    const isUnauthorized = statusCode === 401 || statusCode === 403;

    if (!isHtmlLoginPage && !isUnauthorized) {
      return response;
    }

    const reason = isHtmlLoginPage
      ? 'CodeMie SSO returned an HTML login page instead of an API response'
      : `CodeMie SSO rejected the upstream request with HTTP ${statusCode}`;

    // Stop the invalid upstream body before replacing it with a small, stable
    // JSON error. This also releases the pooled connection promptly.
    response.resume();
    await markAnalyticsAuthInvalid(reason, this.credentials.apiUrl);

    const body = Buffer.from(JSON.stringify({
      error: {
        type: 'authentication_error',
        code: 'AUTH_FAILED',
        message: 'CodeMie SSO session expired. Run `codemie profile login`, then restart the proxy.',
      },
    }));
    const replacement = tools.fromBuffer(response, body);
    replacement.statusCode = 401;
    replacement.statusMessage = 'Unauthorized';
    replacement.headers = {
      'content-type': 'application/json',
      'content-length': String(body.length),
    };

    logger.warn(`[${this.name}] Replaced upstream authentication response`, {
      requestId: context.requestId,
      statusCode,
      contentType,
      reason,
    });

    return replacement;
  }
}
