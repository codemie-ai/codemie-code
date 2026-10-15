/**
 * SSO Session Expiry Detector
 * Priority: 11 (directly after SSOAuthPlugin/JWTAuthPlugin)
 *
 * SOLID: Single responsibility = detect the confirmed oauth2-proxy
 * session-expiry redirect (302/303 to /oauth2/start) and, only when the
 * proxy's own stored SSO credential is at/past its known expiry, replace
 * the relayed response with a parseable 401 and kick off PR #624's
 * existing re-auth plumbing instead of letting the downstream agent write
 * a `<synthetic>` turn.
 *
 * This plugin never touches sso.auth-gate.ts, sso.detached-login.ts, or
 * analytics-auth-status.ts — it only calls their existing exported
 * functions, reusing the shared lock file/marker those already own.
 */

import type { IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { SSOCredentials } from '../../../../core/types.js';
import { markAnalyticsAuthInvalid } from '../../../../../utils/analytics-auth-status.js';
import { startDetachedSsoLogin, describeLogin } from '../../sso.detached-login.js';

const OAUTH2_START_MARKER = '/oauth2/start';
const EXPIRY_LEAD_IN = 'CodeMie SSO session expired.';

export class SSOSessionExpiryPlugin implements ProxyPlugin {
  id = '@codemie/proxy-sso-session-expiry';
  name = 'SSO Session Expiry Detector';
  version = '1.0.0';
  priority = 11;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (!context.credentials || !('cookies' in context.credentials)) {
      return { name: 'sso-session-expiry' }; // no onUpstreamResponse hook: JWT profiles unaffected
    }
    return new SSOSessionExpiryInterceptor(context.credentials as SSOCredentials, context.config.targetApiUrl);
  }
}

class SSOSessionExpiryInterceptor implements ProxyInterceptor {
  name = 'sso-session-expiry';

  constructor(private readonly credentials: SSOCredentials, private readonly targetApiUrl: string) {}

  async onUpstreamResponse(
    _context: ProxyContext,
    response: IncomingMessage,
    tools: UpstreamResponseTools
  ): Promise<IncomingMessage> {
    const location = response.headers['location'];
    const isOauthRedirect =
      (response.statusCode === 302 || response.statusCode === 303) &&
      typeof location === 'string' &&
      location.includes(OAUTH2_START_MARKER);
    if (!isOauthRedirect) return response;

    const expiresAt = this.credentials.expiresAt;
    const confirmedExpired = expiresAt !== undefined && Date.now() >= expiresAt;
    if (!confirmedExpired) return response;

    await tools.readBody(response); // drain the original 302 body; its content is discarded
    await markAnalyticsAuthInvalid(
      `oauth2-proxy redirected to ${OAUTH2_START_MARKER} (expired SSO session)`,
      this.targetApiUrl
    );
    const outcome = await startDetachedSsoLogin(this.targetApiUrl);

    const body = Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: `${EXPIRY_LEAD_IN} ${describeLogin(outcome)}` },
    }), 'utf-8');
    const synthetic = tools.fromBuffer(response, body);
    synthetic.statusCode = 401;
    synthetic.statusMessage = 'Unauthorized';
    synthetic.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
    return synthetic;
  }
}
