/**
 * SSO Session Expiry Detector
 * Priority: 11 (directly after SSOAuthPlugin/JWTAuthPlugin)
 *
 * SOLID: Single responsibility = detect the oauth2-proxy session-expiry
 * redirect (302/303 to /oauth2/start) and replace the relayed response
 * with a parseable 401, kicking off PR #624's existing re-auth plumbing,
 * instead of letting the downstream agent write a `<synthetic>` turn.
 *
 * Acts on the redirect signature alone — a server-side session revoke
 * (e.g. signing out of all sessions, or an admin-forced revoke) does not
 * change the local JWT's own `exp` claim, so requiring the local
 * credential to also look expired would miss the primary real-world
 * trigger for this bug (confirmed by live reproduction on 2026-10-16).
 * Nothing else has ever been observed to produce this exact redirect, so
 * no secondary confirming signal is needed before acting on it.
 *
 * This plugin never touches sso.auth-gate.ts, sso.detached-login.ts, or
 * analytics-auth-status.ts — it only calls their existing exported
 * functions, reusing the shared lock file/marker those already own.
 */

import type { IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { markAnalyticsAuthInvalid } from '../../../../../utils/analytics-auth-status.js';
import { logger } from '../../../../../utils/logger.js';
import { startDetachedSsoLogin, describeLogin, DetachedLoginOutcome } from '../../sso.detached-login.js';

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
    return new SSOSessionExpiryInterceptor(context.config.targetApiUrl);
  }
}

class SSOSessionExpiryInterceptor implements ProxyInterceptor {
  name = 'sso-session-expiry';

  constructor(private readonly targetApiUrl: string) {}

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

    let outcome: DetachedLoginOutcome | undefined;
    let failedStep: string | undefined;
    try {
      failedStep = 'readBody';
      await tools.readBody(response); // drain the original 302 body; its content is discarded
      failedStep = 'markAnalyticsAuthInvalid';
      await markAnalyticsAuthInvalid(
        `oauth2-proxy redirected to ${OAUTH2_START_MARKER} (expired SSO session)`,
        this.targetApiUrl
      );
      failedStep = 'startDetachedSsoLogin';
      outcome = await startDetachedSsoLogin(this.targetApiUrl);
    } catch (error) {
      // Any of the three steps above can reject; without this catch the raw 302
      // would silently pass through and the <synthetic>-turn bug would recur.
      // Still synthesize the 401 below using a generic fallback message.
      logger.error(
        `[${this.name}] ${failedStep} failed while handling an expired SSO session; synthesizing a fallback 401`,
        error
      );
    }

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
