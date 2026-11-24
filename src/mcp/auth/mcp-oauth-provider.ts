/**
 * MCP OAuth Client Provider
 *
 * Implements the OAuthClientProvider interface from the MCP SDK for browser-based
 * OAuth authorization code flow. The login (tokens, plus the refresh token and the client it was
 * issued to) is also persisted per endpoint, see token-store.ts.
 *
 * Flow: 401 → resource metadata → auth server metadata → dynamic client registration
 * (client_name from MCP_CLIENT_NAME env var, default "CodeMie CLI") → browser authorization → callback → token exchange.
 */

import { execFile } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getMcpClientName } from '../constants.js';
import { proxyLog } from '../proxy-logger.js';
import { acquireAuthLock } from './auth-lock.js';
import { startCallbackServer, type CallbackResult } from './callback-server.js';
import {
  forgetPersistedLogin,
  loadPersistedLogin,
  persistLogin,
  type RenewalGrant,
} from './token-store.js';

import { OAuthError, discoverOAuthServerInfo, refreshAuthorization, selectResourceURL } from '@modelcontextprotocol/client';
import type {
  FetchLike,
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/client';

/**
 * OAuth provider for MCP authorization code flow.
 *
 * Refreshing is done here (renewSilently), never by the SDK: it rethrows a refused refresh instead
 * of falling back to a login. So the SDK only ever sees the access token (`tokens()`), while the
 * refresh token lives in `_grant` together with the client it belongs to.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** Without a server URL the provider is memory-only (nothing is persisted or restored). */
  constructor(private readonly serverUrl?: URL) {}

  private _redirectUrl: string | undefined;
  private _clientInfo: OAuthClientInformationMixed | undefined;
  private _tokens: OAuthTokens | undefined;
  private _expiresAt: number | undefined;
  // Refresh token + the client registration it is bound to (see token-store.ts)
  private _grant: RenewalGrant | undefined;
  private _codeVerifier: string | undefined;
  // Reused by later logins so the redirect URI registered with the client stays valid
  private _callbackPort: number | undefined;

  // Callback server state (active during authorization)
  private callbackWait: Promise<CallbackResult> | undefined;
  private callbackClose: (() => void) | undefined;
  // Held from opening the browser until the login settles, so proxies log in one at a time
  private releaseAuthLock: (() => void) | undefined;

  get redirectUrl(): string | undefined {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: getMcpClientName(),
      redirect_uris: this._redirectUrl ? [this._redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /**
   * Pre-start the callback server so that clientMetadata.redirect_uris is
   * populated before the SDK calls registerClient(). Must be called before
   * connecting the HTTP transport.
   */
  async ensureCallbackServer(): Promise<void> {
    if (this.callbackWait) return;
    const { redirectUrl, waitForCallback, close } = await startCallbackServer({
      preferredPort: this._callbackPort,
    });
    this._redirectUrl = redirectUrl;
    this._callbackPort = Number(new URL(redirectUrl).port);
    this.callbackWait = waitForCallback;
    this.callbackClose = close;
    // Nobody awaits this until a login starts. If none is ever needed (a server without OAuth),
    // the callback timeout would surface as an unhandled rejection. Awaiting it later still throws.
    waitForCallback.catch(() => {});
    logger.debug(`[mcp-proxy] Callback server pre-started: ${redirectUrl}`);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInfo = info;
    logger.debug('[mcp-proxy] Saved client information');
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.applyTokens(tokens, this._clientInfo);
    logger.debug('[mcp-proxy] Saved OAuth tokens');
  }

  /** Keep the access token for the SDK, the refresh token (with its client) for renewal, and persist both. */
  private applyTokens(tokens: OAuthTokens, client: OAuthClientInformationMixed | undefined): void {
    const { refresh_token: refreshToken, ...accessToken } = tokens;
    this._tokens = accessToken;
    this._expiresAt = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined;
    if (refreshToken && client) {
      this._grant = { refreshToken, clientInfo: client };
    }
    if (this.serverUrl) {
      persistLogin(this.serverUrl, { tokens: accessToken, expiresAt: this._expiresAt, grant: this._grant });
    }
  }

  /**
   * Seed the login persisted by an earlier run. Call before connecting. The access token may be
   * expired: check tokenNeedsRenewal() and renewSilently(). If the server rejects it anyway, the
   * normal login flow runs and replaces it.
   */
  restorePersistedLogin(): void {
    if (this._tokens || !this.serverUrl) return;
    const login = loadPersistedLogin(this.serverUrl);
    if (!login) return;
    this._tokens = login.tokens;
    this._expiresAt = login.expiresAt ?? 0; // unknown lifetime: renew before first use
    this._grant = login.grant;
  }

  /** True when the current access token is known to be expired (or about to be). */
  tokenNeedsRenewal(skewMs = 60_000): boolean {
    return this._tokens !== undefined && this._expiresAt !== undefined && this._expiresAt - skewMs <= Date.now();
  }

  /** Forget the current access token (not the refresh token), e.g. after renewing it failed. */
  discardTokens(): void {
    this._tokens = undefined;
    this._expiresAt = undefined;
  }

  /**
   * Get a new access token with the refresh token, without any user interaction. Returns false when
   * that is not possible; never throws. A refusal by the server (revoked or expired refresh token,
   * unknown client) ends the grant, anything else (network, server error) may be transient and
   * keeps it for the next attempt.
   */
  async renewSilently(fetchFn?: FetchLike): Promise<boolean> {
    const grant = this._grant;
    if (!grant || !this.serverUrl) return false;

    try {
      const info = await discoverOAuthServerInfo(this.serverUrl, { fetchFn });
      const resource = await selectResourceURL(this.serverUrl, this, info.resourceMetadata);
      const refreshed = await refreshAuthorization(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientInformation: grant.clientInfo,
        refreshToken: grant.refreshToken,
        resource,
        fetchFn,
      });
      this.applyTokens(refreshed, grant.clientInfo);
      return true;
    } catch (error) {
      proxyLog(`[mcp-proxy] Silent renewal failed: ${error instanceof Error ? error.message : error}`);
      if (error instanceof OAuthError) {
        this._grant = undefined;
        forgetPersistedLogin(this.serverUrl);
      }
      return false;
    }
  }

  /**
   * Prepare a login that happens after the initial connect: the callback server of the previous
   * login is gone, and the authorization URL is built from `redirectUrl` before the browser is
   * opened, so a fresh server must exist first. If it could not reuse the old port, the redirect
   * URI registered with the client no longer matches and the client must be registered again.
   */
  async prepareReauthentication(): Promise<void> {
    // A server pre-started at connect time may be unused (no login was needed then) and may have
    // timed out by now. Replace it (the port is freed on close, so the new one can reuse it).
    this.callbackClose?.();
    this.callbackWait = undefined;
    this.callbackClose = undefined;
    await this.ensureCallbackServer();
    const registered = this._clientInfo && 'redirect_uris' in this._clientInfo
      ? this._clientInfo.redirect_uris
      : undefined;
    if (registered && this._redirectUrl && !registered.map(String).includes(this._redirectUrl)) {
      this.invalidateCredentials('client');
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Start ephemeral callback server if not already running
    await this.ensureCallbackServer();

    // Concurrent logins from sibling proxies clobber each other's gateway CSRF/session state
    // in the browser, so wait for any other pending login to finish first.
    if (!this.releaseAuthLock) {
      this.releaseAuthLock = await acquireAuthLock();
    }

    const url = authorizationUrl.toString();
    logger.debug(`[mcp-proxy] Opening browser for authorization`);
    console.error('[mcp-proxy] Opening browser for MCP server authorization...');

    openBrowser(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    return this._codeVerifier || '';
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') {
      this.discardTokens();
    }
    if (scope === 'all') {
      this._grant = undefined;
      if (this.serverUrl) forgetPersistedLogin(this.serverUrl);
    }
    if (scope === 'all' || scope === 'client') {
      this._clientInfo = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      this._codeVerifier = undefined;
    }
    logger.debug(`[mcp-proxy] Invalidated credentials: ${scope}`);
  }

  /**
   * Wait for the OAuth callback after browser redirect.
   * Returns the authorization code from the callback.
   * This is called externally by the bridge after auth() returns 'REDIRECT'.
   */
  async waitForAuthorizationCode(): Promise<string> {
    if (!this.callbackWait) {
      throw new Error('No active authorization flow — callback server not started');
    }

    try {
      const result = await this.callbackWait;
      logger.debug('[mcp-proxy] Received authorization callback');
      return result.code;
    } finally {
      this.callbackWait = undefined;
      this.callbackClose = undefined;
      this.releaseLock();
    }
  }

  private releaseLock(): void {
    this.releaseAuthLock?.();
    this.releaseAuthLock = undefined;
  }

  /**
   * Clean up the callback server if still running (e.g., on shutdown).
   */
  dispose(): void {
    this.callbackClose?.();
    this.callbackWait = undefined;
    this.callbackClose = undefined;
    this.releaseLock();
  }
}

/**
 * Open a URL in the system default browser.
 * Cross-platform: macOS (open), Windows (start), Linux (xdg-open).
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // Use PowerShell Start-Process to avoid CMD metacharacter parsing:
    // `cmd /c start "" url` splits on `&`, truncating auth URLs with query params.
    // PowerShell passes the URL directly to the OS shell handler, preserving all chars.
    const escapedUrl = url.replace(/'/g, "''"); // PowerShell single-quote escaping
    command = 'powershell';
    args = ['-NoProfile', '-Command', `Start-Process '${escapedUrl}'`];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  execFile(command, args, (error) => {
    if (error) {
      // Don't fail — user can manually copy the URL from stderr
      console.error(`[mcp-proxy] Could not open browser automatically. Please open this URL:\n${url}`);
    }
  });
}
