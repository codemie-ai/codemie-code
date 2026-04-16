/**
 * Ephemeral localhost HTTP server for receiving OAuth authorization callbacks.
 *
 * Starts on an OS-assigned port, waits for a single callback with an authorization
 * code, then shuts down. Used during the MCP OAuth browser-based authorization flow.
 */

import { createServer, type Server } from 'http';
import { URL } from 'url';
import { logger } from '../../utils/logger.js';

export interface CallbackResult {
  code: string;
  state?: string;
}

/**
 * Start an ephemeral callback server and return the redirect URL and a promise
 * that resolves with the authorization code when the callback is received.
 */
export async function startCallbackServer(options?: {
  timeoutMs?: number;
}): Promise<{
  redirectUrl: string;
  waitForCallback: Promise<CallbackResult>;
  close: () => void;
}> {
  const timeoutMs = options?.timeoutMs ?? 120_000; // 2 minutes default

  let settled = false;
  let resolveCallback: (result: CallbackResult) => void;
  let rejectCallback: (error: Error) => void;
  const waitForCallback = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);

    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>');
      settle(() => rejectCallback(new Error(`OAuth error: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`)));
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Missing authorization code</h2></body></html>');
      settle(() => rejectCallback(new Error('Missing authorization code in callback')));
      return;
    }

    const state = url.searchParams.get('state') || undefined;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Authorization successful</h2><p>You can close this tab.</p></body></html>');

    settle(() => resolveCallback({ code, state }));
  });

  // Listen on OS-assigned port
  await new Promise<void>((resolve, reject) => {
    server.listen(0, 'localhost', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to get callback server address');
  }

  const redirectUrl = `http://localhost:${address.port}/callback`;
  logger.debug(`[mcp-proxy] OAuth callback server listening on ${redirectUrl}`);

  // Timeout: reject if no callback received within timeoutMs
  const timer = setTimeout(() => {
    settle(() => rejectCallback(new Error(`OAuth authorization timed out after ${timeoutMs / 1000}s`)));
    server.close();
  }, timeoutMs);

  // Auto-close server after callback (success or error)
  const originalWait = waitForCallback;
  const cleanupWait = originalWait.finally(() => {
    clearTimeout(timer);
    server.close();
    logger.debug('[mcp-proxy] OAuth callback server closed');
  });

  const close = () => {
    settle(() => rejectCallback(new Error('Callback server closed')));
    clearTimeout(timer);
    server.close();
  };

  return { redirectUrl, waitForCallback: cleanupWait, close };
}
