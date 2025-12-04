/**
 * SSO Authentication Module
 *
 * Handles browser-based SSO authentication for CodeMie provider.
 * Manages credential storage and session lifecycle.
 */

import { createServer, Server } from 'http';
import { URL } from 'url';
import open from 'open';
import chalk from 'chalk';
import type { SSOAuthConfig, SSOAuthResult, SSOCredentials } from '../../core/types.js';
import { CredentialStore } from '../../../utils/credential-store.js';

/**
 * CodeMie SSO Authentication
 *
 * Provides browser-based SSO authentication for CodeMie provider
 */
export class CodeMieSSO {
  private server?: Server;
  private callbackResult?: SSOAuthResult;
  private codeMieUrl!: string;

  /**
   * Authenticate via browser SSO
   */
  async authenticate(config: SSOAuthConfig): Promise<SSOAuthResult> {
    this.codeMieUrl = config.codeMieUrl;

    try {
      // 1. Start local callback server
      const port = await this.startLocalServer();

      // 2. Construct SSO URL (following plugin pattern)
      const codeMieBase = this.ensureApiBase(config.codeMieUrl);
      const ssoUrl = `${codeMieBase}/v1/auth/login/${port}`;

      // 3. Launch browser
      console.log(chalk.white(`Opening browser for authentication...`));
      await open(ssoUrl);

      // 4. Wait for callback with timeout
      const result = await this.waitForCallback(config.timeout || 120000);

      // 5. Store credentials if successful
      if (result.success && result.apiUrl && result.cookies) {
        const credentials: SSOCredentials = {
          cookies: result.cookies,
          apiUrl: result.apiUrl,
          expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
        };

        const store = CredentialStore.getInstance();
        await store.storeSSOCredentials(credentials);
      }

      return result;

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.cleanup();
    }
  }

  /**
   * Get stored SSO credentials
   */
  async getStoredCredentials(): Promise<SSOCredentials | null> {
    const store = CredentialStore.getInstance();
    const credentials = await store.retrieveSSOCredentials();

    // Check if credentials are expired
    if (credentials && credentials.expiresAt && Date.now() > credentials.expiresAt) {
      await store.clearSSOCredentials();
      return null;
    }

    return credentials;
  }

  /**
   * Clear stored credentials
   */
  async clearStoredCredentials(): Promise<void> {
    const store = CredentialStore.getInstance();
    await store.clearSSOCredentials();
  }

  /**
   * Ensure API base URL has correct format
   */
  private ensureApiBase(rawUrl: string): string {
    let base = rawUrl.replace(/\/$/, '');
    // If user entered only host, append the known API context
    if (!/\/code-assistant-api(\/|$)/i.test(base)) {
      base = `${base}/code-assistant-api`;
    }
    return base;
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
                <h2 class="${result.success ? 'success' : 'error'}">
                  ${result.success ? '✅ Authentication Successful' : '❌ Authentication Failed'}
                </h2>
                <p>You can close this window and return to your terminal.</p>
                ${result.error ? `<p class="error">Error: ${result.error}</p>` : ''}
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
                <p>Error: ${error.message}</p>
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

      if (!token.cookies) {
        throw new Error('Token missing cookies field');
      }

      // Try to fetch config.js to resolve actual API URL
      let apiUrl = this.ensureApiBase(this.codeMieUrl);
      try {
        const configResponse = await fetch(`${apiUrl}/config.js`, {
          headers: {
            'cookie': Object.entries(token.cookies)
              .map(([key, value]) => `${key}=${value}`)
              .join(';')
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
        cookies: token.cookies
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Wait for OAuth callback with timeout
   */
  private async waitForCallback(timeout: number): Promise<SSOAuthResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Authentication timeout - no response received'));
      }, timeout);

      const checkResult = () => {
        if (this.callbackResult) {
          clearTimeout(timer);
          resolve(this.callbackResult);
        } else {
          setTimeout(checkResult, 100);
        }
      };

      checkResult();
    });
  }

  /**
   * Cleanup server resources
   */
  private cleanup(): void {
    if (this.server) {
      this.server.close();
      delete this.server;
    }
  }
}
