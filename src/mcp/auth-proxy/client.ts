/**
 * MCP Auth Proxy — loopback control-plane client (CLI side).
 *
 * Talks to the daemon's /healthz and /shutdown endpoints over whichever
 * protocol the daemon listener speaks. For TLS daemons the locally-generated
 * CA is pinned explicitly (`ca:`) — never rejectUnauthorized: false.
 */
import http from 'node:http';
import https from 'node:https';
import type { RouteStatus } from './types.js';

export interface DaemonEndpoint {
  port: number;
  /** True when the daemon listener speaks HTTPS (from the daemon state file). */
  tls?: boolean;
  /** CA certificate PEM to pin for TLS daemons. */
  caPem?: string;
}

export interface HealthzRoute {
  id: string;
  upstreamUrl: string;
  status: RouteStatus;
}

export interface HealthzResponse {
  status: string;
  routes: HealthzRoute[];
}

interface LoopbackRequestOptions {
  host: string;
  port: number;
  path: string;
  method?: string;
  timeout: number;
  ca?: string;
}

function transportFor(endpoint: DaemonEndpoint): typeof http | typeof https {
  return endpoint.tls === true ? https : http;
}

function baseOptions(endpoint: DaemonEndpoint, path: string): LoopbackRequestOptions {
  return {
    host: '127.0.0.1',
    port: endpoint.port,
    path,
    timeout: 2000,
    ...(endpoint.tls === true && endpoint.caPem !== undefined ? { ca: endpoint.caPem } : {}),
  };
}

export function fetchHealth(endpoint: DaemonEndpoint): Promise<HealthzResponse> {
  return new Promise((resolveHealth, rejectHealth) => {
    const request = transportFor(endpoint).get(baseOptions(endpoint, '/healthz'), (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolveHealth(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as HealthzResponse);
        } catch (error) {
          rejectHealth(error as Error);
        }
      });
    });
    request.on('error', rejectHealth);
    request.on('timeout', () => request.destroy(new Error('healthz timed out')));
  });
}

/**
 * Ask the daemon to shut itself down gracefully via the loopback control
 * endpoint. Cross-platform graceful stop (Windows has no POSIX signals, so a
 * signal there is a hard kill that skips the daemon's cleanup). Resolves true
 * if the daemon acknowledged (2xx), false on any error/timeout — the caller
 * then falls back to OS signals.
 */
export function requestShutdown(endpoint: DaemonEndpoint): Promise<boolean> {
  return new Promise((resolveShutdown) => {
    const request = transportFor(endpoint).request(
      { ...baseOptions(endpoint, '/shutdown'), method: 'POST' },
      (res) => {
        res.resume(); // drain the 202 body so the socket can close
        resolveShutdown(
          res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300
        );
      }
    );
    request.on('error', () => resolveShutdown(false));
    request.on('timeout', () => {
      request.destroy();
      resolveShutdown(false);
    });
    request.end();
  });
}
