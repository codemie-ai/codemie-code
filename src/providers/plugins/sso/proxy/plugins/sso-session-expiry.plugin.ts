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
 * A redirect on a request that was sent with credentials a finished sign-in has since replaced is not
 * an expiry: the request is replayed once with the stored cookies and that response is returned. If
 * the replay is itself the redirect the session really is gone and the expiry path below runs; if
 * the replay throws the client gets a 401 asking it to re-send. No marker is written and no sign-in
 * is started for a superseded request.
 *
 * KNOWN GAP: detection relies ONLY on this exact 302/303-to-/oauth2/start signature. Two other
 * gateway rejection shapes bypass it silently (no marker written, no re-login triggered, no
 * failing test): a plain 401, and an HTML 200 (the latter is already handled on the metrics
 * path — see metrics-api-client.ts). There are now three independent classifiers of "SSO
 * session rejected" in this codebase (metrics-api-client.ts: 401/403/HTML; the OTLP forwarder:
 * 401/403; this plugin: 302 to /oauth2/start) with no shared `isSessionRejection()`. A follow-up
 * could unify them; for this PR, this comment states the assumption instead.
 *
 * KNOWN GAP: the synthetic 401 body below is always Anthropic-shaped (`{type, error: {type,
 * message}}`), regardless of which client is proxied — Codex goes through this same plugin (see
 * `createInterceptor`'s guard, which only checks for SSO cookies, not client type) and expects an
 * OpenAI-shaped error instead. Left as-is for this PR (third review round, 2026-10-20); a
 * follow-up should branch on `context.config.clientType` the way the request normalizers do.
 *
 * This plugin's own code never touches sso.auth-gate.ts or analytics-auth-status.ts — it only
 * calls their existing exported functions, reusing the shared lock file/marker those already
 * own. (sso.detached-login.ts's lock-creation race is fixed by a separate commit in this PR —
 * this plugin itself still only calls that module's exports, never modifies it.)
 */

import type { IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { markAnalyticsAuthInvalid } from '../../../../../utils/analytics-auth-status.js';
import { logger } from '../../../../../utils/logger.js';
import { startDetachedSsoLogin, describeLogin, DetachedLoginOutcome } from '../../sso.detached-login.js';
import { supersedingCookieHeader } from '../../session/cookie-auth.js';
import type { CredentialRefresher } from './credential-refresh.js';
import type { SSOCredentials } from '@/providers/core/types.js';

const OAUTH2_START_MARKER = '/oauth2/start';
const EXPIRY_LEAD_IN = 'CodeMie SSO session expired.';
const RENEWED_MESSAGE =
  'CodeMie SSO session was just renewed; this request used the previous credentials. Please re-send your prompt.';

/**
 * Anthropic-shaped 401. The body must later become per-client (Codex expects an OpenAI-shaped
 * error), as the known gap above says.
 */
function syntheticUnauthorized(
  response: IncomingMessage,
  tools: UpstreamResponseTools,
  message: string
): IncomingMessage {
  const body = Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'authentication_error', message },
  }), 'utf-8');
  const synthetic = tools.fromBuffer(response, body);
  synthetic.statusCode = 401;
  synthetic.statusMessage = 'Unauthorized';
  synthetic.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
  return synthetic;
}

function isOauthRedirect(response: IncomingMessage): boolean {
  const location = response.headers['location'];
  return (
    (response.statusCode === 302 || response.statusCode === 303) &&
    typeof location === 'string' &&
    location.includes(OAUTH2_START_MARKER)
  );
}

export class SSOSessionExpiryPlugin implements ProxyPlugin {
  id = '@codemie/proxy-sso-session-expiry';
  name = 'SSO Session Expiry Detector';
  version = '1.0.0';
  priority = 11;

  /**
   * PR #655 review asked whether this should skip `startDetachedSsoLogin` when an API key is
   * configured, the way `sso.auth-gate.ts`'s own `!input.apiKey` guard does for the
   * `UserPromptSubmit` hook path. It cannot: `CodeMieProxy.start()` (sso.proxy.ts) resolves
   * `authMethod` to exactly one of JWT or SSO once at daemon startup, mutually exclusively — an
   * API-key/JWT profile's `PluginContext.credentials` never has a `cookies` key, so the guard
   * below already makes this plugin a permanent no-op for it. There is no code path where this
   * interceptor's `onUpstreamResponse` runs AND an API key is the active auth method.
   */
  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (!context.credentials || !('cookies' in context.credentials)) {
      return { name: 'sso-session-expiry' }; // no onUpstreamResponse hook: JWT profiles unaffected
    }
    return new SSOSessionExpiryInterceptor(
      context.config.targetApiUrl,
      context.credentialRefresher as CredentialRefresher<SSOCredentials> | undefined
    );
  }
}

class SSOSessionExpiryInterceptor implements ProxyInterceptor {
  name = 'sso-session-expiry';

  constructor(
    private readonly targetApiUrl: string,
    private readonly credentialRefresher?: CredentialRefresher<SSOCredentials>
  ) {}

  async onUpstreamResponse(
    context: ProxyContext,
    response: IncomingMessage,
    tools: UpstreamResponseTools
  ): Promise<IncomingMessage> {
    if (!isOauthRedirect(response)) return response;

    const freshCookies = await supersedingCookieHeader(context.headers['cookie'], this.credentialRefresher);
    if (freshCookies !== null) {
      logger.debug(`[${this.name}] request carried superseded credentials; not treating the redirect as an expiry`);
      try {
        await tools.readBody(response); // keep-alive socket: the 302 body must be consumed
      } catch (error) {
        logger.debug(`[${this.name}] draining the redirect body failed`, error);
      }
      const replayed = await this.replayWithFreshCookies(context, tools, freshCookies);
      if (!replayed) {
        return syntheticUnauthorized(response, tools, RENEWED_MESSAGE);
      }
      if (!isOauthRedirect(replayed)) return replayed;
      // The fresh credentials were rejected too, so the session really is gone: handle the replayed
      // redirect as an expiry below. The replay is never repeated.
      response = replayed;
    }

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

    const login = describeLogin(outcome ?? 'failed');
    // After a sign-in that just finished the text already says so; "session expired" would contradict it.
    return syntheticUnauthorized(response, tools, outcome === 'signed-in-recently' ? login : `${EXPIRY_LEAD_IN} ${login}`);
  }

  /**
   * Sends the request once more with the cookies a finished sign-in stored. `tools.retry` reuses
   * `context.headers` as they are rather than re-running the request interceptors, so the fresh
   * cookie header is put there first. A request without a buffered body (GET, HEAD, DELETE) is
   * replayed with that null body. Resolves null when the replay throws.
   */
  private async replayWithFreshCookies(
    context: ProxyContext,
    tools: UpstreamResponseTools,
    freshCookies: string
  ): Promise<IncomingMessage | null> {
    try {
      context.headers['cookie'] = freshCookies;
      return await tools.retry(context.requestBody);
    } catch (error) {
      logger.debug(`[${this.name}] replaying the request with the renewed credentials failed`, error);
      return null;
    }
  }
}
