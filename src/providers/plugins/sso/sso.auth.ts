/**
 * SSO Authentication Module
 *
 * Handles browser-based SSO authentication for CodeMie provider.
 * Manages credential storage and session lifecycle.
 */

import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import { URL } from 'url';
import open from 'open';
import chalk from 'chalk';
import type { SSOAuthConfig, SSOAuthResult } from '../../core/types.js';
import { clearAnalyticsAuthStatus } from '../../../utils/analytics-auth-status.js';
import { withVerifiedOwner } from '../../core/credential-owner.js';
import { ensureApiBase } from '../../core/codemie-auth-helpers.js';
import { logger } from '../../../utils/logger.js';
import { deriveExpiresAt } from './auth/strategies/cookie.strategy.js';
import { storeSSOAuth, clearSSOAuth, hasUsableCookies, buildCookieHeader } from './auth/index.js';
import type { SSOLoginResult } from './auth/index.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export { deriveExpiresAt };

/**
 * CodeMie SSO Authentication
 *
 * Provides browser-based SSO authentication for CodeMie provider
 */
export class CodeMieSSO {
  private server?: Server;
  private callbackResult?: SSOAuthResult;
  private codeMieUrl!: string;
  private abortController?: AbortController;
  private isAuthenticating = false;

  /**
   * Authenticate via browser SSO
   *
   * On success the credential is stored through the SSO auth resolver and returned as `auth`.
   */
  async authenticate(config: SSOAuthConfig): Promise<SSOLoginResult> {
    this.codeMieUrl = config.codeMieUrl;
    this.isAuthenticating = true;
    this.abortController = new AbortController();

    // Register signal handlers for graceful termination (following agent.ts pattern)
    const sigintHandler = () => {
      if (this.isAuthenticating) {
        if (!config.quiet) {
          console.log(chalk.yellow('\n⚠️  Authentication cancelled by user'));
        }
        this.abortController?.abort();
      }
    };

    const sigtermHandler = () => {
      if (this.isAuthenticating) {
        if (!config.quiet) {
          console.log(chalk.yellow('\n⚠️  Authentication terminated'));
        }
        this.abortController?.abort();
      }
    };

    process.once('SIGINT', sigintHandler);
    process.once('SIGTERM', sigtermHandler);

    try {
      // 1. Start local callback server
      const port = await this.startLocalServer();

      // 2. Construct SSO URL (following plugin pattern)
      const codeMieBase = ensureApiBase(config.codeMieUrl);
      const ssoUrl = `${codeMieBase}/v1/auth/login/${port}`;

      // 3. Launch browser
      if (!config.quiet) {
        console.log(chalk.white(`Opening browser for authentication...`));
        console.log(chalk.dim(`  If browser does not open, visit: ${ssoUrl}`));
      } else {
        logger.info(`[SSO] Opening browser for authentication: ${ssoUrl}`);
      }
      if (process.platform === 'win32') {
        // explorer.exe is Windows-native and has no PowerShell dependency,
        // avoiding failures on machines where WDAC/AppLocker blocks Start-Process.
        spawn('explorer.exe', [ssoUrl], { detached: true, stdio: 'ignore' }).unref();
      } else {
        await open(ssoUrl);
      }

      // 4. Wait for callback with timeout and abort signal
      const result = await this.waitForCallback(
        config.timeout || 120000,
        this.abortController.signal
      );

      // 5. Store credentials if successful. The resolver picks cookie vs JWT and clears the other type's slot.
      const auth = result.success ? await storeSSOAuth(result, this.codeMieUrl) : null;
      // Establish the signed-in email now (best-effort; a failed lookup is retried at most every 30 s by the hook/daemon)
      const verified = auth ? await withVerifiedOwner(auth) : null;
      if (verified) {
        // Fresh credentials — analytics auth is healthy again
        await clearAnalyticsAuthStatus();
      }

      return { ...result, ...(verified ? { auth: verified } : {}) };

    } catch (error) {
      // Handle abort as user cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Authentication cancelled by user'
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.isAuthenticating = false;

      // Remove signal handlers to prevent memory leaks (following agent.ts pattern)
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);

      this.cleanup();
    }
  }

  /**
   * Clear stored credentials — every credential type (SSO cookies and the JWT stored when a reverse
   * proxy in front of the backend stripped cookies). A caller asking to clear "the SSO login" means
   * either shape, not just whichever one happens to exist.
   */
  async clearStoredCredentials(baseUrl?: string): Promise<void> {
    await clearSSOAuth(baseUrl);
  }

  /**
   * Start local HTTP server for OAuth callback
   */
  private startLocalServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      let serverPort: number | undefined;

      this.server = createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: Missing URL');
          return;
        }

        // Use locally scoped port from closure
        if (!serverPort) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error: Server not ready');
          return;
        }

        const url = new URL(req.url, `http://localhost:${serverPort}`);

        // Handle the OAuth callback
        this.handleCallback(url).then(result => {
          this.callbackResult = result;

          // Send success page
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="UTF-8">
                <title>CodeMie Authentication</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .success { color: #28a745; }
                  .error { color: #dc3545; }
                </style>
              </head>
              <body>
                ${result.success ? `
                <h2 class="success">✅ Authentication Successful</h2>
                <p id="msg">Authentication complete. This window will close in <span id="countdown">3</span> seconds.</p>
                <script>
                  let n = 3;
                  const el = document.getElementById('countdown');
                  const t = setInterval(function() {
                    n--;
                    if (n <= 0) {
                      clearInterval(t);
                      window.close();
                      setTimeout(function() {
                        const msg = document.getElementById('msg');
                        if (msg) msg.textContent = 'Authentication complete. You can close this tab.';
                      }, 300);
                      return;
                    }
                    if (el) el.textContent = String(n);
                  }, 1000);
                </script>` : `
                <h2 class="error">❌ Authentication Failed</h2>
                <p>You can close this window and return to your terminal.</p>
                ${result.error ? `<p class="error">Error: ${escapeHtml(result.error)}</p>` : ''}`
                }
              </body>
            </html>
          `);

          // Close server safely
          if (this.server) {
            this.server.close();
          }
        }).catch(error => {
          this.callbackResult = { success: false, error: error.message };
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="UTF-8">
                <title>CodeMie Authentication Error</title>
              </head>
              <body>
                <h2>❌ Authentication Failed</h2>
                <p>Error: ${escapeHtml(error.message)}</p>
                <p>You can close this window and return to your terminal.</p>
              </body>
            </html>
          `);
          // Close server safely
          if (this.server) {
            this.server.close();
          }
        });
      });

      this.server.listen(0, () => {
        const address = this.server!.address();
        serverPort = typeof address === 'object' && address ? address.port : 0;
        resolve(serverPort);
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Handle OAuth callback from browser
   */
  private async handleCallback(url: URL): Promise<SSOAuthResult> {
    try {
      const query = url.searchParams;
      let raw = query.get('token') || query.get('auth') || query.get('data');

      if (!raw) {
        // Try to extract from URL-encoded query
        const decoded = decodeURIComponent(url.search);
        const match = /(?:^|[?&])token=([^&]+)/.exec(decoded);
        if (match && match[1]) raw = match[1];
      }

      if (!raw) {
        throw new Error('Missing token parameter in OAuth callback');
      }

      // Decode base64 token (following plugin pattern)
      const token = JSON.parse(Buffer.from(raw, 'base64').toString('ascii'));

      const hasCookies = hasUsableCookies(token.cookies);
      // The backend's `authorization` field carries a JWT, optionally already prefixed with
      // `Bearer ` (case-insensitive) — strip it so the stored token is the raw JWT; the resolved
      // JWT credential's `headers` add their own `Bearer ` prefix when injecting the header.
      const jwt = typeof token.authorization === 'string' && token.authorization.trim()
        ? token.authorization.trim().replace(/^Bearer\s+/i, '')
        : undefined;

      if (!hasCookies && !jwt) {
        throw new Error('Token missing cookies and authorization fields');
      }

      // Try to fetch config.js to resolve actual API URL. Authenticates with cookies when
      // present; a cookie-stripping reverse proxy leaves none, so fall back to the JWT as a
      // Bearer Authorization header instead. One of the two is guaranteed by the check above.
      let apiUrl = ensureApiBase(this.codeMieUrl);
      try {
        const configResponse = await fetch(`${apiUrl}/config.js`, {
          headers: hasCookies
            ? { 'cookie': buildCookieHeader(token.cookies) }
            : {
                'authorization': `Bearer ${jwt}`
              }
        });

        if (configResponse.ok) {
          const configText = await configResponse.text();
          const viteApiMatch = /VITE_API_URL:\s*"([^"]+)"/.exec(configText);
          if (viteApiMatch && viteApiMatch[1]) {
            apiUrl = viteApiMatch[1].replace(/\/$/, '');
          }
        }
      } catch {
        // Silently fallback to default API URL - config.js fetch is optional
      }

      return {
        success: true,
        apiUrl,
        ...(hasCookies ? { cookies: token.cookies } : {}),
        ...(jwt ? { jwt } : {}),
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Wait for OAuth callback with timeout and abort support
   */
  private async waitForCallback(
    timeout: number,
    abortSignal: AbortSignal
  ): Promise<SSOAuthResult> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let pollInterval: NodeJS.Timeout | undefined;

      // Handle abort signal
      const abortHandler = () => {
        if (timer) clearTimeout(timer);
        if (pollInterval) clearInterval(pollInterval);
        reject(new Error('AbortError'));
      };

      // Handle timeout
      timer = setTimeout(() => {
        if (pollInterval) clearInterval(pollInterval);
        abortSignal.removeEventListener('abort', abortHandler);
        reject(new Error('Authentication timeout - no response received'));
      }, timeout);

      // Register abort handler
      if (abortSignal.aborted) {
        clearTimeout(timer);
        reject(new Error('AbortError'));
        return;
      }
      abortSignal.addEventListener('abort', abortHandler);

      // Poll for callback result (non-recursive)
      pollInterval = setInterval(() => {
        if (this.callbackResult) {
          clearTimeout(timer);
          clearInterval(pollInterval);
          abortSignal.removeEventListener('abort', abortHandler);
          resolve(this.callbackResult);
        }
      }, 100);
    });
  }

  /**
   * Cleanup server resources
   */
  private cleanup(): void {
    if (this.server) {
      // Force close all connections immediately
      this.server.closeAllConnections?.();

      // Close the server
      this.server.close(() => {
        // Server closed callback (optional)
      });

      delete this.server;
    }

    // Reset state
    this.callbackResult = undefined;
    this.abortController = undefined;
  }
}
