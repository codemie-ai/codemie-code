// Builders for native Claude Code OTLP/JSON log exports, and a poster that sends them to the daemon
// exactly as Claude Code does (http/json, Authorization: Bearer <gateway key>, resourceLogs/scopeLogs/logRecords).
import { randomUUID } from 'node:crypto';

export const CLAUDE_VERSION = '2.1.319';

const toNano = (ms) => String(BigInt(Math.round(ms)) * 1_000_000n);
const attr = (key, v) => {
  if (typeof v === 'number') return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  return { key, value: { stringValue: String(v) } };
};

/** One log record. `eventName` is the short name ("user_prompt"); Claude Code also sets body = "claude_code.<name>". */
export function logRecord({ eventName, sessionId, atMs = Date.now(), sequence, attributes = {}, withSessionId = true }) {
  const attrs = {
    'user.id': 'live-user-id',
    ...(withSessionId ? { 'session.id': sessionId } : {}),
    'organization.id': 'live-org',
    'user.email': 'live.tester@example.com',
    'terminal.type': 'live-test',
    'event.name': eventName,
    'event.timestamp': new Date(atMs).toISOString(),
    ...(sequence !== undefined ? { 'event.sequence': sequence } : {}),
    ...attributes,
  };
  return {
    timeUnixNano: toNano(atMs),
    observedTimeUnixNano: toNano(atMs),
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: `claude_code.${eventName}` },
    attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)),
    droppedAttributesCount: 0,
  };
}

/** One export request carrying the given log records. */
export function logsExport(records, { version = CLAUDE_VERSION } = {}) {
  return {
    resourceLogs: [{
      resource: { attributes: [attr('service.name', 'claude-code'), attr('service.version', version), attr('os.type', 'windows'), attr('host.arch', 'amd64')] },
      scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events', version }, logRecords: records }],
    }],
  };
}

const mk = (eventName, defaults) => (sessionId, atMs, a = {}) =>
  logRecord({ eventName, sessionId, atMs, attributes: { ...defaults, ...a } });

// Named native events (attributes follow what Claude Code 2.1.x emits; fixtures/native-startup-records.json
// holds the real capture when it could be taken, otherwise these are a best-effort synthetic model).
export const native = {
  hook_registered: mk('hook_registered', { hook_event: 'SessionStart', hook_type: 'command', source: 'userSettings' }),
  plugin_loaded: mk('plugin_loaded', { 'plugin.name': 'live-plugin', 'plugin.version': '1.0.0' }),
  managed_settings_resolved: mk('managed_settings_resolved', { source: 'none' }),
  mcp_server_connection: mk('mcp_server_connection', { status: 'connected', transport_type: 'stdio', server_scope: 'user' }),
  hook_execution_start: mk('hook_execution_start', { hook_event: 'SessionStart', hook_name: 'SessionStart:resume', num_hooks: 1 }),
  hook_execution_complete: mk('hook_execution_complete', { hook_event: 'SessionStart', hook_name: 'SessionStart:resume', num_hooks: 1, num_success: 1, num_blocking: 0, num_non_blocking_error: 0, num_cancelled: 0 }),
  user_prompt: mk('user_prompt', { prompt_length: 5, prompt: '<REDACTED>' }),
  api_request: mk('api_request', { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.01, duration_ms: 1200 }),
  tool_result: mk('tool_result', { tool_name: 'Bash', success: true, duration_ms: 50 }),
};

/**
 * POST an export to the daemon like Claude Code does. `daemon` is the handle from lib/daemon.mjs.
 * Returns the response status. A body that holds no UUID-v4 is dropped by the daemon (documented behavior).
 */
export async function postLogs(daemon, records, opts = {}) {
  const body = JSON.stringify(logsExport(Array.isArray(records) ? records : [records], opts));
  const res = await fetch(`${daemon.url}/v1/analytics/otlp/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.gatewayKey}` },
    body,
  });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

export const newSessionId = () => randomUUID();
