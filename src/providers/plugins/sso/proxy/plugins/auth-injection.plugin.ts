/**
 * Auth Injection Plugin
 * Priority: 10 (must run first)
 *
 * SOLID: Single responsibility = inject the resolved SSO credential's headers
 * KISS: One interceptor for every credential type. The credential (cookies or a JWT) comes from
 * the shared CredentialRefresher, which adopts whatever type the store holds now, so a re-login
 * that changed the type reaches live requests without a proxy restart.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';
import { AuthenticationError } from '../proxy-errors.js';
import { CredentialRefresher } from './credential-refresh.js';
import { describeAuthForLog } from '../../auth/index.js';

export class AuthInjectionPlugin implements ProxyPlugin {
  id = '@codemie/proxy-auth';
  name = 'Auth Injection';
  version = '1.0.0';
  priority = 10;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (!context.credentialRefresher) {
      // No credentials at all (e.g. a non-SSO provider): zero runtime cost, no hooks implemented.
      return { name: 'auth-injection' };
    }

    return new AuthInjectionInterceptor(context.credentialRefresher);
  }
}

class AuthInjectionInterceptor implements ProxyInterceptor {
  name = 'auth-injection';

  constructor(private readonly credentials: CredentialRefresher) {}

  async onRequest(context: ProxyContext): Promise<void> {
    const auth = await this.credentials.refresh();

    // Only an explicit credential (`--jwt-token`, `CODEMIE_JWT_TOKEN`, the bearer-auth profile's
    // token) is rejected locally on expiry: nothing can rotate it. A store-sourced SSO login
    // (cookies or a JWT) is sent upstream even when expired, so the server's rejection drives
    // SSOSessionExpiryPlugin's detached re-login, which a local throw here would bypass.
    if (auth.source === 'explicit' && auth.expiresAt && Date.now() > auth.expiresAt) {
      throw new AuthenticationError(
        'Stored credentials expired. Run `codemie profile login` and reconnect the proxy.'
      );
    }

    const description = describeAuthForLog(auth);
    if (description.droppedCookieNames && description.droppedCookieNames.length > 0) {
      logger.warn(`[${this.name}] Ignoring invalid cookie entries`, {
        invalidCookieCount: description.droppedCookieNames.length,
        invalidCookieNames: description.droppedCookieNames,
      });
    }

    if (auth.authValue === '') {
      throw new AuthenticationError(
        'Stored SSO session cookies are invalid. Run `codemie profile login` and reconnect the proxy.'
      );
    }

    // Header names are lowercase ('cookie', 'authorization') to match Node.js HTTP conventions
    Object.assign(context.headers, auth.headers);
    context.sentAuth = auth;

    logger.debug(`[${this.name}] Injected ${auth.type} credentials`, {
      type: description.type,
      cookieCount: description.cookieCount,
      cookieNames: description.cookieNames,
    });
  }
}
