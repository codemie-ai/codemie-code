import { maskSecretsInLongText } from '@/utils/long-text-masking.js';
import { isSensitiveKey, maskSecretsDeep, REDACTED } from '@/utils/security.js';

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
 * remaining string is scanned for embedded secrets (JSON-encoded `tool_parameters`, `tool_input`, ...).
 * Strings are scanned in full, not cut at 64 KB: telemetry is forwarded as sent, with no later length limit.
 */
export function maskOtlpJson(parsed: unknown): unknown {
  return maskSecretsDeep(redactSensitiveAttributes(parsed, 0), undefined, maskSecretsInLongText);
}
