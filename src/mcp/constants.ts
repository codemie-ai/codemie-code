import { logger } from '@/utils/logger.js';

/** Default client_name for MCP OAuth dynamic client registration. Overridable via MCP_CLIENT_NAME env var. */
export const DEFAULT_MCP_CLIENT_NAME = 'CodeMie CLI';

/** Get the MCP client name from env var or default. */
export function getMcpClientName(): string {
  return process.env.MCP_CLIENT_NAME || DEFAULT_MCP_CLIENT_NAME;
}

const DEFAULT_AUTH_TIMEOUT_SECONDS = 300;
const MIN_AUTH_TIMEOUT_SECONDS = 10;
const MAX_AUTH_TIMEOUT_SECONDS = 3600;

/** Timings (ms) for the MCP OAuth flow, all derived from one timeout T. */
export interface McpAuthTimings {
  /** How long to wait for the OAuth callback (T). */
  callbackTimeoutMs: number;
  /** How long to wait for another process's auth lock (0.75 T). */
  lockMaxWaitMs: number;
  /** Age after which an auth lock is considered stale (1.25 T). */
  lockStaleMs: number;
}

/**
 * Resolve OAuth timings from MCP_PROXY_AUTH_TIMEOUT_SECONDS (read at call time).
 * Accepts a trimmed decimal integer, digits only, 10..3600; anything else falls back to 300 s.
 */
export function getMcpAuthTimings(): McpAuthTimings {
  const raw = process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS;
  let seconds = DEFAULT_AUTH_TIMEOUT_SECONDS;

  if (raw !== undefined) {
    const trimmed = raw.trim();
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    if (
      Number.isSafeInteger(parsed) &&
      parsed >= MIN_AUTH_TIMEOUT_SECONDS &&
      parsed <= MAX_AUTH_TIMEOUT_SECONDS
    ) {
      seconds = parsed;
    } else {
      logger.debug(
        `[mcp-auth] Ignoring invalid MCP_PROXY_AUTH_TIMEOUT_SECONDS; using ${DEFAULT_AUTH_TIMEOUT_SECONDS}s`
      );
    }
  }

  return {
    callbackTimeoutMs: seconds * 1000,
    lockMaxWaitMs: seconds * 750,
    lockStaleMs: seconds * 1250,
  };
}
