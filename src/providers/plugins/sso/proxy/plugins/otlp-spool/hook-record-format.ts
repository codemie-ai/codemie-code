/**
 * The hook record: one CLI hook event as one OTLP JSON `LogsData` line, and the line id a reader
 * tells a repeated line from a new one by: the folder file's name and a hash of the spool line's bytes,
 * so a line keeps its id in every file and every move it reaches. Nothing outside this module names a
 * key of a hook record.
 */
import { createHash } from 'node:crypto';

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } }
  | Record<string, never>;

interface KeyValue {
  key: string;
  value: AnyValue;
}

const SERVICE_NAME = 'codemie-cli';
const SCOPE_NAME = 'codemie.hooks';
const LINE_ID_KEY = 'codemie.line_id';
/** Hex digits of the SHA-256 a line id keeps. */
const LINE_HASH_HEX_DIGITS = 32;
const EVIDENCE_V_KEY = 'codemie.evidence_v';
const EVENT_TYPE_KEY = 'event_type';
const USER_EMAIL_KEY = 'user.email';
/** Keys the record itself owns: an event's own field of that name is not carried. */
const RESERVED_KEYS = new Set([EVENT_TYPE_KEY, USER_EMAIL_KEY, 'session.id', 'prompt.id']);
/** A container nested deeper than this inside a field is carried as its compact JSON text. */
const MAX_NESTING = 16;
const INT64_MIN = -(2 ** 63);
const INT64_LIMIT = 2 ** 63;
const EXPORT_KEYS = ['resourceLogs', 'resourceMetrics', 'resourceSpans', 'resource_logs', 'resource_metrics', 'resource_spans'] as const;

/** The envelope the proxy writes into a spool hooks file per event. */
interface HookEnvelope {
  hookEvent?: unknown;
  evidence_v?: unknown;
  historicalEnd?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `level` is the nesting of `value` inside its field: the field's own value is level 1. */
function toAnyValue(value: unknown, level: number): AnyValue {
  if (value === null) return {};
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= INT64_MIN && value < INT64_LIMIT
      ? { intValue: BigInt(value).toString() }
      : { doubleValue: value };
  }
  if (level > MAX_NESTING) return { stringValue: JSON.stringify(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => toAnyValue(item, level + 1)) } };
  return { kvlistValue: { values: toKeyValues(value as Record<string, unknown>, level + 1) } };
}

function toKeyValues(object: Record<string, unknown>, level: number): KeyValue[] {
  return Object.entries(object).map(([key, value]) => ({ key, value: toAnyValue(value, level) }));
}

function timeUnixNano(timestamp: unknown, nowMs: number): string {
  const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  const ms = Number.isNaN(parsed) ? Math.trunc(nowMs) : parsed;
  return (BigInt(ms) * 1_000_000n).toString();
}

/**
 * The line id of a spool line (without its newline) moved into the folder file `name`:
 * `<name>:<the first 32 hex digits of the SHA-256 of the line's UTF-8 bytes>`.
 */
export function lineIdOf(name: string, line: string): string {
  return `${name}:${createHash('sha256').update(line, 'utf8').digest('hex').slice(0, LINE_HASH_HEX_DIGITS)}`;
}

/**
 * One hook event as one OTLP JSON `LogsData` line (no newline); `null` for an event whose `type` is
 * not a non-empty string. The caller owns `nowMs`, the time of an event whose `timestamp` does not
 * parse, so the same event and `nowMs` always give the same bytes.
 */
export function encodeHookRecord(
  event: Record<string, unknown>,
  opts: { evidenceV?: 1; lineId?: string; nowMs: number }
): string | null {
  if (typeof event['type'] !== 'string' || event['type'] === '') return null;
  // Values JSON drops or nulls (undefined, a function, a non-finite number) are dropped or nulled the same way.
  const normalized = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;

  const attributes: KeyValue[] = [];
  for (const [key, value] of Object.entries(normalized)) {
    if (key === 'type') {
      attributes.push({ key: EVENT_TYPE_KEY, value: toAnyValue(value, 1) });
    } else if (!RESERVED_KEYS.has(key)) {
      attributes.push({ key, value: toAnyValue(value, 1) });
    }
  }
  const email = normalized['user_email'];
  if (typeof email === 'string' && email !== '') {
    attributes.push({ key: USER_EMAIL_KEY, value: { stringValue: email } });
  }

  const resourceAttributes: KeyValue[] = [{ key: 'service.name', value: { stringValue: SERVICE_NAME } }];
  if (opts.lineId !== undefined) resourceAttributes.push({ key: LINE_ID_KEY, value: { stringValue: opts.lineId } });

  const scope =
    opts.evidenceV === 1
      ? { name: SCOPE_NAME, attributes: [{ key: EVIDENCE_V_KEY, value: { intValue: '1' } }] }
      : { name: SCOPE_NAME };

  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope,
            logRecords: [
              { timeUnixNano: timeUnixNano(normalized['timestamp'], opts.nowMs), eventName: normalized['type'], attributes },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Appends `codemie.line_id` to every resource of one OTLP JSON export request line, camelCase or snake_case; `null`
 * for a line that does not parse or is not an export request.
 */
export function addLineId(line: string, lineId: string): string | null {
  return editResourceAttributes(line, (attributes) => [...attributes, { key: LINE_ID_KEY, value: { stringValue: lineId } }]);
}

/**
 * Sets the resource attribute `user.email` to `email` on every resource of one OTLP JSON export request line,
 * camelCase or snake_case, replacing a resource-level one already there; `null` for a line that does not parse or is
 * not an export request.
 */
export function setUserEmail(line: string, email: string): string | null {
  return editResourceAttributes(line, (attributes) => [
    ...attributes.filter((a) => !(isObject(a) && a['key'] === USER_EMAIL_KEY)),
    { key: USER_EMAIL_KEY, value: { stringValue: email } },
  ]);
}

/** One OTLP JSON export request line with `edit` applied to every resource's attributes; `null` as `addLineId` says. */
function editResourceAttributes(line: string, edit: (attributes: unknown[]) => unknown[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const key = EXPORT_KEYS.find((k) => Array.isArray(parsed[k]));
  if (!key) return null;
  for (const entry of parsed[key] as unknown[]) {
    if (!isObject(entry)) continue;
    const resource = isObject(entry['resource']) ? entry['resource'] : (entry['resource'] = {});
    resource['attributes'] = edit(Array.isArray(resource['attributes']) ? (resource['attributes'] as unknown[]) : []);
  }
  return JSON.stringify(parsed);
}

/**
 * One line of a spool hooks file: the envelope's `hookEvent` as it lies (`raw`) and parsed
 * (`event`), with its `evidence_v` and its `historicalEnd`; `null` when the envelope or its
 * `hookEvent` does not parse to an object.
 */
export function parseHookEnvelope(
  line: string
): { event: Record<string, unknown>; raw: string; evidenceV?: 1; historicalEnd?: true } | null {
  try {
    const envelope = JSON.parse(line) as HookEnvelope;
    if (!isObject(envelope) || typeof envelope.hookEvent !== 'string') return null;
    const raw = envelope.hookEvent;
    const event: unknown = JSON.parse(raw);
    if (!isObject(event)) return null;
    return {
      event,
      raw,
      ...(envelope.evidence_v === 1 ? { evidenceV: 1 as const } : {}),
      ...(envelope.historicalEnd === true ? { historicalEnd: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** The `event_id` of one encoded hook record; `undefined` for a line without one or one that does not parse. */
export function hookRecordEventId(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as {
      resourceLogs?: { scopeLogs?: { logRecords?: { attributes?: KeyValue[] }[] }[] }[];
    };
    const attributes = parsed?.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]?.attributes;
    const value = attributes?.find((a) => a.key === 'event_id')?.value;
    return value && 'stringValue' in value ? value.stringValue : undefined;
  } catch {
    return undefined;
  }
}
