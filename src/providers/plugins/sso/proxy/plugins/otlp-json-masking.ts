import { sanitizeDeep, type ObfuscationMode, type SanitizeOptions } from '@/utils/analytics-obfuscation.js';
import { resolveAnalyticsSettings, type AnalyticsSettings } from '@/utils/analytics-settings.js';
import { isSensitiveKey, REDACTED } from '@/utils/security.js';
import { readSessionCwds } from '@/agents/core/session-cwd-pin.js';

/** Deeper than any real OTLP export; anything beyond is left to `maskSecretsDeep`, which redacts it whole. */
const MAX_WALK_DEPTH = 64;

/** OTLP/JSON `KeyValue`: the attribute name sits in a `key` string, the data under an `AnyValue` in `value`. */
function isKeyValue(node: Record<string, unknown>): node is { key: string; value: Record<string, unknown> } {
  const { key, value } = node;
  return typeof key === 'string' && typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replace the `AnyValue` of every OTLP `KeyValue` whose attribute name is a secret name
 * (`api_key`, `auth_token`, `password`, ...) with a redacted string value. `maskSecretsDeep`
 * only sees property names, so it cannot do this: in OTLP the name is data, not a property.
 * Recognised by shape, so resource, log, span, event and metric data-point attributes and
 * nested `kvlistValue`/`arrayValue` entries are all covered. The input is never mutated.
 */
function redactSensitiveAttributes(node: unknown, depth: number): unknown {
  if (typeof node !== 'object' || node === null || depth >= MAX_WALK_DEPTH) {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => redactSensitiveAttributes(item, depth + 1));
  }
  const record = node as Record<string, unknown>;
  if (isKeyValue(record) && isSensitiveKey(record.key)) {
    return { ...record, value: { stringValue: REDACTED } };
  }
  const walked: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(record)) {
    walked[name] = redactSensitiveAttributes(child, depth + 1);
  }
  return walked;
}

/**
 * Mask a parsed OTLP/JSON export: secret-named attributes are redacted by name, then every
 * remaining string is scanned for embedded secrets (JSON-encoded `tool_parameters`, `tool_input`, ...)
 * and, in `on` mode, for PII. Strings are scanned in full, not cut at 64 KB: telemetry is forwarded
 * as sent. A string that fails in `on` mode becomes the failure placeholder; the rest is kept.
 * `mode` comes from `resolveSessionObfuscationMode`, never from the request body.
 */
export function maskOtlpJson(parsed: unknown, mode: ObfuscationMode, opts?: SanitizeOptions): unknown {
  const masked = sanitizeDeep(redactSensitiveAttributes(parsed, 0), mode, opts);
  if (mode === 'on' && typeof masked === 'string' && typeof parsed === 'object' && parsed !== null) {
    // The whole walk failed: the placeholder step itself did not work, so the record is dropped by the caller.
    throw new Error('OTLP JSON obfuscation failed for the whole record');
  }
  return masked;
}

export interface SessionModeDeps {
  sessionCwds: (sessionId: string) => Promise<string[]>;
  resolveSettings: (cwd: string | undefined) => AnalyticsSettings;
}

/** Sessions resolved `on`: sticky for the life of the daemon, so a later config edit cannot drop a session to off. */
const sessionsKnownOn = new Set<string>();

/**
 * Obfuscation mode for one session's OTLP export. The daemon has no working directory of its own, so the project
 * directories come from the session mapping its hooks wrote (`session-cwd-pin.ts`); each is resolved with the global
 * layer, and any layer on gives `on` (protective, sticky for the life of the daemon). A session with no mapping yet
 * follows the global layer. Any read failure gives `on`. Nothing in the request is consulted.
 */
export async function resolveSessionObfuscationMode(
  sessionId: string,
  deps: SessionModeDeps = { sessionCwds: readSessionCwds, resolveSettings: resolveAnalyticsSettings }
): Promise<ObfuscationMode> {
  try {
    if (sessionsKnownOn.has(sessionId)) return 'on';
    const cwds = await deps.sessionCwds(sessionId);
    const scopes: (string | undefined)[] = cwds.length > 0 ? cwds : [undefined];
    if (scopes.some((cwd) => deps.resolveSettings(cwd).obfuscation === 'on')) {
      sessionsKnownOn.add(sessionId);
      return 'on';
    }
    return 'off';
  } catch {
    return 'on';
  }
}
