/**
 * Proxy Types
 *
 * Type definitions for proxy system.
 */

import { IncomingHttpHeaders } from 'http';

/**
 * Proxy configuration
 */
export interface ProxyConfig {
  targetApiUrl: string;
  port?: number;
  host?: string;
  clientType?: string;
  timeout?: number;
  model?: string;
  provider?: string;
  integrationId?: string;
  sessionId?: string;
}

/**
 * Proxy context - shared state across interceptors
 */
export interface ProxyContext {
  requestId: string;
  sessionId: string;
  agentName: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  requestBody: string | null;
  requestStartTime: number;
  targetUrl?: string;
  metadata: Record<string, unknown>;
}

/**
 * Upstream response
 */
export interface UpstreamResponse {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  body: Buffer | null;
}
