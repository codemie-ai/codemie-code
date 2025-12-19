/**
 * Proxy Types
 *
 * Type definitions for proxy system.
 */

import { IncomingHttpHeaders } from 'http';
import type { CodeMieConfigOptions } from '../../../../env/types.js';

/**
 * Proxy configuration
 */
export interface ProxyConfig {
  targetApiUrl: string;
  port?: number;
  host?: string;
  clientType?: string;
  timeout?: number;
  profile?: string;         // Profile name for traceability
  model?: string;
  provider?: string;
  integrationId?: string;
  sessionId?: string;
  version?: string;         // CLI version for metrics and headers
  profileConfig?: CodeMieConfigOptions; // Full profile config (read once at CLI level)
}

/**
 * Proxy context - shared state across interceptors
 */
export interface ProxyContext {
  requestId: string;
  sessionId: string;
  agentName: string;
  profile?: string;           // Profile name (e.g., 'default', 'work')
  provider?: string;          // Provider name (e.g., 'openai', 'ai-run-sso')
  model?: string;             // Model name (e.g., 'gpt-4', 'claude-3-5-sonnet')
  method: string;
  url: string;
  headers: Record<string, string>;
  requestBody: Buffer | null; // Changed to Buffer to preserve byte integrity
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
