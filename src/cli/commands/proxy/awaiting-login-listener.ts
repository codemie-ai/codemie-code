/**
 * Placeholder listener for a proxy daemon that has no usable SSO credentials.
 *
 * Keeps the daemon's port bound so clients get an actionable Anthropic-shaped 401
 * ("sign in") instead of a refused connection, and the port stays reserved until
 * the daemon swaps the real proxy back in once credentials reappear. `/health`
 * answers 200 like the real proxy, so the watcher sees a live socket and its deep
 * check (an authenticated call) reports `unauthorized`.
 */
import { createServer, type Server } from 'node:http';

export interface AwaitingLoginListener {
  port: number;
  url: string;
  message: string;
  stop: () => Promise<void>;
}

export interface AwaitingLoginOptions {
  /** Port to bind; omitted/0 lets the OS pick. */
  port?: number;
  host: string;
  /** Recovery path: the port must be reclaimed, never replaced by a random one. */
  pinnedPort?: boolean;
  /** Shown to the client verbatim (e.g. "... Please run: codemie profile login --url ..."). */
  message: string;
}

const PINNED_RETRIES = 5;
const PINNED_RETRY_DELAY_MS = 200;

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function bind(server: Server, opts: AwaitingLoginOptions): Promise<void> {
  const port = opts.port ?? 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await listen(server, port, opts.host);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) {
        throw error;
      }
      if (!opts.pinnedPort) {
        return listen(server, 0, opts.host); // initial bind: a fallback port is acceptable
      }
      if (attempt >= PINNED_RETRIES) {
        throw error;
      }
      await new Promise<void>((r) => setTimeout(r, PINNED_RETRY_DELAY_MS));
    }
  }
}

export async function startAwaitingLoginListener(opts: AwaitingLoginOptions): Promise<AwaitingLoginListener> {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.statusCode = 200;
      const address = server.address();
      res.end(JSON.stringify({
        status: 'ok',
        port: typeof address === 'object' && address ? address.port : opts.port,
        pid: process.pid,
        analytics: { credentials: 'stale' },
      }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: opts.message },
    }));
  });

  await bind(server, opts);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);

  return {
    port,
    url: `http://${opts.host}:${port}`,
    message: opts.message,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
