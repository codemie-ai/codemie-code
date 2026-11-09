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
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';

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
  /** Analytics delivery health from the daemon `/health` reply; set only when `expectedPid` matched the replying daemon */
  analytics?: AnalyticsHealthReply;
}

export interface ProxyHealthOptions {
  port: number;
  gatewayKey: string;
  deep?: boolean;
  host?: string;
  /** Pid of the daemon this check is about; when set, the reply's analytics field is read and trusted only if its pid matches */
  expectedPid?: number;
}

export const SHALLOW_TIMEOUT_MS = 1500;
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

/**
 * The shallow liveness request: `GET /health` of the proxy on `port`, localhost by default. Rejects when nothing
 * answers in time; the same deadline aborts a body read that stalls after the headers.
 */
export function fetchProxyHealth(port: number, host = '127.0.0.1'): Promise<Response> {
  return fetch(`http://${host}:${port}/health`, { method: 'GET', signal: AbortSignal.timeout(SHALLOW_TIMEOUT_MS) });
}

/**
 * Reads the analytics health from a `/health` reply body. Accepts it only when the body's `pid` is the daemon
 * we expect (a port can be taken over by another process) and `credentials` is exactly `'ok'` or `'stale'`.
 */
export function parseAnalyticsReply(body: unknown, expectedPid: number): AnalyticsHealthReply | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { pid, analytics } = body as { pid?: unknown; analytics?: unknown };
  if (pid !== expectedPid) return undefined;
  if (typeof analytics !== 'object' || analytics === null) return undefined;
  const { credentials } = analytics as { credentials?: unknown };
  return credentials === 'ok' || credentials === 'stale' ? { credentials } : undefined;
}

async function readAnalyticsReply(res: Response, expectedPid: number): Promise<AnalyticsHealthReply | undefined> {
  try {
    return parseAnalyticsReply(await res.json(), expectedPid);
  } catch (error) {
    logger.debug('[proxy-health] Could not read analytics from /health reply', error);
    return undefined;
  }
}

export async function checkProxyHealth(
  opts: ProxyHealthOptions
): Promise<ProxyHealthResult> {
  const host = opts.host ?? '127.0.0.1';
  const base = `http://${host}:${opts.port}`;
  let analytics: AnalyticsHealthReply | undefined;

  // 1. Shallow liveness
  try {
    const res = await fetchProxyHealth(opts.port, host);
    if (!res.ok) {
      return {
        healthy: false,
        level: 'shallow',
        code: 'dead-socket',
        reason: `Health endpoint returned ${res.status}`,
      };
    }
    if (opts.expectedPid !== undefined) {
      analytics = await readAnalyticsReply(res, opts.expectedPid);
    }
  } catch (error) {
    return {
      healthy: false,
      level: 'shallow',
      code: 'dead-socket',
      reason: `Proxy not responding on ${base}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const analyticsField = analytics ? { analytics } : {};

  if (!opts.deep) {
    return { healthy: true, level: 'shallow', code: 'ok', ...analyticsField };
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
        reason: 'SSO session expired — run `codemie profile login` and restart the proxy.',
        ...analyticsField,
      };
    }
    if (!res.ok) {
      return {
        healthy: false,
        level: 'deep',
        code: 'upstream-error',
        reason: `Upstream model discovery returned ${res.status}`,
        ...analyticsField,
      };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return {
        healthy: false,
        level: 'deep',
        code: 'unauthorized',
        reason: 'SSO session expired — run `codemie proxy stop && codemie profile login` to re-authenticate.',
        ...analyticsField,
      };
    }
    return { healthy: true, level: 'deep', code: 'ok', ...analyticsField };
  } catch (error) {
    logger.debug('[proxy-health] Deep check failed', error);
    return {
      healthy: false,
      level: 'deep',
      code: 'upstream-error',
      reason: `Upstream check failed: ${error instanceof Error ? error.message : String(error)}`,
      ...analyticsField,
    };
  }
}
