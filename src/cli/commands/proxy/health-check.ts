/**
 * Shared proxy health checks.
 *
 * - shallow: hit the pre-auth `/health` endpoint → confirms the socket is alive.
 * - deep: shallow + one authenticated upstream call (`/v1/llm_models`) through
 *   the gateway → also confirms the SSO session/token is still valid.
 *
 * Consumed by `proxy status`, `proxy connect desktop`, and the in-daemon
 * ProxyWatcher. Never throws — always resolves to a typed result.
 */
import { logger } from '../../../utils/logger.js';

export type ProxyHealthLevel = 'shallow' | 'deep';

export type ProxyHealthCode =
  | 'ok'
  | 'dead-socket'
  | 'unauthorized'
  | 'upstream-error';

export interface ProxyHealthResult {
  healthy: boolean;
  level: ProxyHealthLevel;
  code: ProxyHealthCode;
  reason?: string;
}

export interface ProxyHealthOptions {
  port: number;
  gatewayKey: string;
  deep?: boolean;
  host?: string;
}

const SHALLOW_TIMEOUT_MS = 1500;
const DEEP_TIMEOUT_MS = 6000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkProxyHealth(
  opts: ProxyHealthOptions
): Promise<ProxyHealthResult> {
  const host = opts.host ?? '127.0.0.1';
  const base = `http://${host}:${opts.port}`;

  // 1. Shallow liveness
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: 'GET' }, SHALLOW_TIMEOUT_MS);
    if (!res.ok) {
      return {
        healthy: false,
        level: 'shallow',
        code: 'dead-socket',
        reason: `Health endpoint returned ${res.status}`,
      };
    }
  } catch (error) {
    return {
      healthy: false,
      level: 'shallow',
      code: 'dead-socket',
      reason: `Proxy not responding on ${base}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!opts.deep) {
    return { healthy: true, level: 'shallow', code: 'ok' };
  }

  // 2. Deep: authenticated upstream call via the gateway
  try {
    const res = await fetchWithTimeout(
      `${base}/v1/llm_models?include_all=true`,
      { method: 'GET', headers: { Authorization: `Bearer ${opts.gatewayKey}` } },
      DEEP_TIMEOUT_MS
    );
    if (res.status === 401 || res.status === 403) {
      return {
        healthy: false,
        level: 'deep',
        code: 'unauthorized',
        reason: 'SSO session expired — run `codemie proxy connect desktop` to re-login.',
      };
    }
    if (!res.ok) {
      return {
        healthy: false,
        level: 'deep',
        code: 'upstream-error',
        reason: `Upstream model discovery returned ${res.status}`,
      };
    }
    return { healthy: true, level: 'deep', code: 'ok' };
  } catch (error) {
    logger.debug('[proxy-health] Deep check failed', error);
    return {
      healthy: false,
      level: 'deep',
      code: 'upstream-error',
      reason: `Upstream check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
