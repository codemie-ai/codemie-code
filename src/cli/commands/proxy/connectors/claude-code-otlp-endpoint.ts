/**
 * Keeps the user-level Claude Code OTLP endpoint in step with the live proxy daemon.
 * Only the exact endpoint/header pair `connect` writes is ever read or rewritten.
 */
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { getClaudeSettingsPath } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { writeAtomically } from './vscode.js';
import { isCodemieOwnedEnvValue, readSettingsFile, type ClaudeSettings } from './claude-code-otlp.js';

const OTLP_ENDPOINT_PATH = '/v1/analytics/otlp';
// The only shape `connect` writes (daemon binds 127.0.0.1); anything else is the user's own destination.
const LOCAL_DAEMON_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/analytics\/otlp$/;

/** CodeMie-written local-daemon OTLP endpoint/header pair in the user-level settings, or null (not connected, foreign, unreadable). */
async function readOwnedOtlpEnv(): Promise<{ settings: ClaudeSettings; env: Record<string, string> } | null> {
  try {
    const settings = await readSettingsFile(getClaudeSettingsPath());
    const env = settings.env ?? {};
    return isCodemieOwnedEnvValue('OTEL_EXPORTER_OTLP_ENDPOINT', env.OTEL_EXPORTER_OTLP_ENDPOINT, env) &&
      LOCAL_DAEMON_ENDPOINT.test(env.OTEL_EXPORTER_OTLP_ENDPOINT)
      ? { settings, env }
      : null;
  } catch {
    return null;
  }
}

/** Port of the loopback endpoint Claude Code is currently told to export to, or null. */
export async function readConfiguredOtlpPort(): Promise<number | null> {
  const owned = await readOwnedOtlpEnv();
  if (!owned) {
    return null;
  }
  try {
    const url = new URL(owned.env.OTEL_EXPORTER_OTLP_ENDPOINT);
    const port = Number.parseInt(url.port, 10);
    return url.hostname === '127.0.0.1' && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export interface OtlpEndpointCheck {
  configured: string;
  expected: string;
  /** Endpoint and gateway-key header both match the live daemon. */
  matches: boolean;
}

/** Compares Claude Code's configured OTLP endpoint with the live daemon; null when CodeMie does not own it. */
export async function checkClaudeCodeOtlpEndpoint(
  state: { url: string; gatewayKey: string }
): Promise<OtlpEndpointCheck | null> {
  const owned = await readOwnedOtlpEnv();
  if (!owned) {
    return null;
  }
  const expected = `${state.url}${OTLP_ENDPOINT_PATH}`;
  const configured = owned.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return {
    configured,
    expected,
    matches: configured === expected &&
      owned.env.OTEL_EXPORTER_OTLP_HEADERS === `Authorization=Bearer ${state.gatewayKey}`,
  };
}

/**
 * Re-points CodeMie's own OTLP endpoint/header at the live daemon (user-level settings only; every
 * other key, hook and the project allowlist stay as-is). Claude Code reads settings at startup, so
 * this takes effect from the NEXT session; a running one keeps its old endpoint. Never throws.
 */
export async function refreshClaudeCodeOtlpEndpoint(
  state: { url: string; gatewayKey: string }
): Promise<boolean> {
  try {
    const check = await checkClaudeCodeOtlpEndpoint(state);
    const owned = check && !check.matches ? await readOwnedOtlpEnv() : null;
    if (!check || !owned) {
      return false;
    }
    const env = {
      ...owned.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: check.expected,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${state.gatewayKey}`,
    };
    await writeAtomically(getClaudeSettingsPath(), JSON.stringify({ ...owned.settings, env }, null, 2) + '\n');
    logger.info(
      '[proxy] Re-pointed Claude Code OTLP endpoint at the live daemon',
      ...sanitizeLogArgs({ from: check.configured, to: check.expected })
    );
    return true;
  } catch (error) {
    logger.warn(
      '[proxy] Could not refresh the Claude Code OTLP endpoint',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) })
    );
    return false;
  }
}
