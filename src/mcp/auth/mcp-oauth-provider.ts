/**
 * MCP OAuth Client Provider
 *
 * Implements the OAuthClientProvider interface from the MCP SDK for browser-based
 * OAuth authorization code flow.
 *
 * Flow: 401 → resource metadata → auth server metadata → dynamic client registration
 * (client_name from MCP_CLIENT_NAME env var, default "CodeMie CLI") → browser authorization → callback → token exchange.
 *
 * Tokens and client registration info are persisted to disk (encrypted, keyed by server
 * URL — see mcp-token-store.ts) so a new proxy process — one is spawned per MCP server on
 * every Claude Code session start — can reuse a still-valid token instead of forcing a new
 * browser authorization each time. See https://github.com/codemie-ai/codemie-code/issues/643.
 * The PKCE code verifier stays memory-only: it is only ever needed within the single
 * authorization flow that generated it and must not leak across sessions.
 */

import { execFile } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getMcpClientName } from '../constants.js';
import { startCallbackServer, type CallbackResult } from './callback-server.js';
import { loadMcpCredentials, saveMcpCredentials, clearMcpCredentials } from './mcp-token-store.js';

import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/client';

/**
 * OAuth provider for the MCP authorization code flow. When constructed with a
 * `serverUrl`, tokens and client info are persisted to disk and reloaded on the next
 * process start; without one it behaves exactly as before (memory-only, for tests).
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private _redirectUrl: string | undefined;
  private _clientInfo: OAuthClientInformationMixed | undefined;
  private _tokens: OAuthTokens | undefined;
  private _codeVerifier: string | undefined;
  private loadedFromDisk = false;

  // Callback server state (active during authorization)
  private callbackWait: Promise<CallbackResult> | undefined;
  private callbackClose: (() => void) | undefined;

  constructor(private readonly serverUrl?: string) {}

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
    const { redirectUrl, waitForCallback, close } = await startCallbackServer();
    this._redirectUrl = redirectUrl;
    this.callbackWait = waitForCallback;
    this.callbackClose = close;
    logger.debug(`[mcp-proxy] Callback server pre-started: ${redirectUrl}`);
  }

  /**
   * Loads persisted tokens/client info from disk at most once per instance. A value
   * already set in memory (e.g. by a test, or saved earlier this process) wins over
   * whatever is on disk.
   */
  private async ensureLoadedFromDisk(): Promise<void> {
    if (this.loadedFromDisk || !this.serverUrl) return;
    this.loadedFromDisk = true;
    const stored = await loadMcpCredentials(this.serverUrl);
    if (!stored) return;
    if (this._tokens === undefined) this._tokens = stored.tokens;
    if (this._clientInfo === undefined) this._clientInfo = stored.clientInformation;
    if (stored.tokens || stored.clientInformation) {
      logger.debug('[mcp-proxy] Loaded persisted MCP OAuth credentials from disk');
    }
  }

  private async persistToDisk(): Promise<void> {
    if (!this.serverUrl) return;
    await saveMcpCredentials(this.serverUrl, {
      clientInformation: this._clientInfo,
      tokens: this._tokens,
    });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.ensureLoadedFromDisk();
    return this._clientInfo;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this._clientInfo = info;
    logger.debug('[mcp-proxy] Saved client information');
    await this.persistToDisk();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.ensureLoadedFromDisk();
    return this._tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._tokens = tokens;
    logger.debug('[mcp-proxy] Saved OAuth tokens');
    await this.persistToDisk();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Start ephemeral callback server if not already running
    if (!this.callbackWait) {
      const { redirectUrl, waitForCallback, close } = await startCallbackServer();
      this._redirectUrl = redirectUrl;
      this.callbackWait = waitForCallback;
      this.callbackClose = close;
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

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      this._tokens = undefined;
    }
    if (scope === 'all' || scope === 'client') {
      this._clientInfo = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      this._codeVerifier = undefined;
    }
    logger.debug(`[mcp-proxy] Invalidated credentials: ${scope}`);

    if (this.serverUrl && (scope === 'all' || scope === 'tokens' || scope === 'client')) {
      if (scope === 'all') {
        await clearMcpCredentials(this.serverUrl);
      } else {
        await this.persistToDisk();
      }
    }
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
    }
  }

  /**
   * Clean up the callback server if still running (e.g., on shutdown).
   */
  dispose(): void {
    this.callbackClose?.();
    this.callbackWait = undefined;
    this.callbackClose = undefined;
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
