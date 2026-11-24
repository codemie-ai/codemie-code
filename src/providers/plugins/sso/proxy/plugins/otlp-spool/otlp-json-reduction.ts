/**
 * Forward-time reduction of one masked native OTLP/JSON export (EPMCDME-17748).
 *
 * Walks the parsed export by shape: every `KeyValue` (`{ key, value }`) is reduced against
 * `OTLP_ATTRIBUTE_KEEP_LIST`, and a log record `body` string is replaced whole. Numeric and boolean values pass
 * unchanged. Nothing is read from settings: the caller reduces exactly the records of a session whose bound decision is on.
 */
import { placeholder, reduceRecord } from '@/agents/core/analytics-reduction.js';
import { OTLP_ATTRIBUTE_KEEP_LIST } from './otlp-reader.js';

type JsonObject = Record<string, unknown>;

/** Deeper than any real OTLP export; a deeper node is replaced whole. */
const MAX_DEPTH = 64;
const STRING_VALUE_KEYS = ['stringValue', 'string_value'] as const;
const NON_TEXT_VALUE_KEYS = ['intValue', 'int_value', 'doubleValue', 'double_value', 'boolValue', 'bool_value'] as const;

const isObject = (node: unknown): node is JsonObject => typeof node === 'object' && node !== null && !Array.isArray(node);

function isKeyValue(node: JsonObject): node is JsonObject & { key: string; value: JsonObject } {
  return typeof node['key'] === 'string' && isObject(node['value']);
}

/** A `{ stringValue }` AnyValue spelled the way the input spelled it. */
function textValue(like: JsonObject, text: string): JsonObject {
  return { [STRING_VALUE_KEYS.find((name) => name in like) ?? 'stringValue']: text };
}

function reduceToolParameters(text: string): string {
  const toolParameters = OTLP_ATTRIBUTE_KEEP_LIST.nested!['tool_parameters'];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return placeholder('tool_parameters');
    return JSON.stringify(reduceRecord(parsed, toolParameters));
  } catch {
    return placeholder('tool_parameters');
  }
}

function reduceKeyValue(node: JsonObject & { key: string; value: JsonObject }): JsonObject {
  const { key, value } = node;
  if (NON_TEXT_VALUE_KEYS.some((name) => name in value)) return node;
  const textKey = STRING_VALUE_KEYS.find((name) => typeof value[name] === 'string');
  if (textKey && OTLP_ATTRIBUTE_KEEP_LIST.nested?.[key]) {
    return { ...node, value: textValue(value, reduceToolParameters(value[textKey] as string)) };
  }
  if (textKey && OTLP_ATTRIBUTE_KEEP_LIST.keep.has(key)) return node;
  // text not on the list, and any list / map / bytes value, which may hold content
  return { ...node, value: textValue(value, placeholder(key)) };
}

function walk(node: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return placeholder('depth');
  if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
  if (!isObject(node)) return node;
  if (isKeyValue(node)) return reduceKeyValue(node);
  const out: JsonObject = {};
  for (const [name, child] of Object.entries(node)) {
    out[name] = name === 'body' && isObject(child) ? textValue(child, placeholder('body')) : walk(child, depth + 1);
  }
  return out;
}

/**
 * The reduced record as one NDJSON line, or `undefined` when the line cannot be parsed. An unparseable record
 * of a reduced session is never sent: the caller consumes it.
 */
export function reduceOtlpJsonRecord(record: string): string | undefined {
  try {
    return JSON.stringify(walk(JSON.parse(record), 0));
  } catch {
    return undefined;
  }
}
