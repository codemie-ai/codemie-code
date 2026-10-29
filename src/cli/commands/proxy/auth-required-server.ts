/**
 * AuthRequiredServer — fallback listener for the proxy daemon.
 *
 * When the SSO login has expired and the daemon cannot rebuild the full proxy (no stored
 * credentials), it used to leave nothing listening on the pinned port. Clients such as the VS Code
 * Claude Code extension and Claude Desktop then saw "connection refused" with no hint that a
 * sign-in was needed. This listener keeps the port bound and answers every request with the same
 * 401 `authentication_error` the SSO session-expiry plugin produces, and starts the (locked,
 * throttled) browser sign-in. The daemon swaps it back for the full proxy once new credentials
 * appear (see ProxyHost / ProxyWatcher).
 */
import { createServer, type Server } from 'node:http';
import { startDetachedSsoLogin } from '@/providers/plugins/sso/sso.detached-login.js';
import { buildSessionExpiredBody } from '@/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.js';
import { logger } from '@/utils/logger.js';

export interface AuthRequiredServerOptions {
  host: string;
  port: number;
  /** URL passed to the browser sign-in (the proxy's target API URL). */
  loginUrl: string;
}

export class AuthRequiredServer {
  private server: Server | null = null;

  constructor(private readonly opts: AuthRequiredServerOptions) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req.method, req.url, req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.opts.host, port: this.opts.port }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    logger.info(`[auth-required] Listening on ${this.opts.host}:${this.opts.port}; answering 401 until a new sign-in is stored`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handle(
    method: string | undefined,
    url: string | undefined,
    req: NodeJS.ReadableStream,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    req.resume(); // discard any request body
    // Liveness stays 200 so socket-level checks see a bound port; the deep check
    // (an authenticated call) gets the 401 below and reports `unauthorized`.
    if (method === 'GET' && url?.split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'auth-required' }));
      return;
    }

    const outcome = await startDetachedSsoLogin(this.opts.loginUrl);
    const body = buildSessionExpiredBody(outcome);
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': String(body.length) });
    res.end(body);
  }
}
