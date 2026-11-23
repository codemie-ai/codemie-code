import { OBFUSCATION_FAILURE_PLACEHOLDER, sanitizeText, type ObfuscationMode } from '@/utils/analytics-obfuscation.js';
import { PII_EXEMPT_KEYS } from '@/utils/analytics-pii-exempt.js';
import { logger } from '@/utils/logger.js';
import { MAX_SNAPSHOT_BYTES, type OtlpSignal } from './otlp-spool/otlp-reader.js';

/**
 * Minimal, dependency-free OTLP/protobuf rewriter. It follows the OTLP field numbers down to the
 * string `AnyValue` leaves (log body, attribute values, span/event names, status messages, metric
 * point attributes), obfuscates only those, and copies every other field (known or unknown)
 * byte for byte. Parent length prefixes are recomputed. A body with nothing to change is returned
 * as the very same buffer.
 */

interface MessageShape {
  /** Field numbers holding a UTF-8 string that is obfuscated as free text. */
  strings?: number[];
  /** Field number -> nested message shape name. */
  kids?: Record<number, string>;
  /** `KeyValue`: field 1 is the attribute name, field 2 its `AnyValue`. */
  keyValue?: boolean;
}

const MAX_DEPTH = 32;

/** Attributes the forwarder's range proof reads; their values are identifiers, never rewritten. */
const PROOF_KEYS = new Set(['session.id', 'session_id', 'codemie_project_name']);

/** A proof attribute's value is kept only while it looks like an identifier; anything else is free text and is obfuscated. */
const IDENTIFIER_VALUE = /^[A-Za-z0-9._:@-]{1,128}$/;

const SHAPES: Record<string, MessageShape> = {
  any: { strings: [1], kids: { 5: 'array', 6: 'kvlist' } },
  array: { kids: { 1: 'any' } },
  kvlist: { kids: { 1: 'kv' } },
  kv: { keyValue: true, kids: { 2: 'any' } },
  resource: { kids: { 1: 'kv' } },
  scope: { kids: { 3: 'kv' } },
  // logs
  logsReq: { kids: { 1: 'logsRes' } },
  logsRes: { kids: { 1: 'resource', 2: 'logsScope' } },
  logsScope: { kids: { 1: 'scope', 2: 'logRecord' } },
  logRecord: { strings: [12], kids: { 5: 'any', 6: 'kv' } },
  // traces
  tracesReq: { kids: { 1: 'tracesRes' } },
  tracesRes: { kids: { 1: 'resource', 2: 'tracesScope' } },
  tracesScope: { kids: { 1: 'scope', 2: 'span' } },
  span: { strings: [3, 5], kids: { 9: 'kv', 11: 'spanEvent', 13: 'spanLink', 15: 'spanStatus' } },
  spanEvent: { strings: [2], kids: { 3: 'kv' } },
  spanLink: { kids: { 5: 'kv' } },
  spanStatus: { strings: [2] },
  // metrics
  metricsReq: { kids: { 1: 'metricsRes' } },
  metricsRes: { kids: { 1: 'resource', 2: 'metricsScope' } },
  metricsScope: { kids: { 1: 'scope', 2: 'metric' } },
  metric: { strings: [1, 2, 3], kids: { 5: 'gauge', 7: 'gauge', 9: 'histogram', 10: 'expHistogram', 11: 'gauge' } },
  gauge: { kids: { 1: 'numberPoint' } },
  histogram: { kids: { 1: 'histogramPoint' } },
  expHistogram: { kids: { 1: 'expHistogramPoint' } },
  numberPoint: { kids: { 7: 'kv', 5: 'exemplar' } },
  histogramPoint: { kids: { 9: 'kv', 8: 'exemplar' } },
  expHistogramPoint: { kids: { 1: 'kv', 11: 'exemplar' } },
  exemplar: { kids: { 7: 'kv' } },
};

const ROOT_BY_SIGNAL: Record<OtlpSignal, string> = {
  logs: 'logsReq',
  traces: 'tracesReq',
  metrics: 'metricsReq',
};

class MalformedProtobuf extends Error {}

interface Cursor {
  p: number;
}

function readVarint(buf: Buffer, c: Cursor, end: number): number {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (c.p >= end) throw new MalformedProtobuf('varint');
    const byte = buf[c.p++];
    result += (byte & 0x7f) * mul;
    if ((byte & 0x80) === 0) return result;
    mul *= 128;
  }
  throw new MalformedProtobuf('varint');
}

function encodeVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

function sanitizeLeaf(buf: Buffer, start: number, end: number, mode: ObfuscationMode): Buffer | null {
  const text = buf.toString('utf8', start, end);
  // Invalid UTF-8 would be rewritten lossily (U+FFFD) and cannot be proven free of sensitive text.
  if (mode === 'on' && !Buffer.from(text, 'utf8').equals(buf.subarray(start, end))) {
    return Buffer.from(OBFUSCATION_FAILURE_PLACEHOLDER, 'utf8');
  }
  const clean = sanitizeText(text, mode);
  return clean === text ? null : Buffer.from(clean, 'utf8');
}

/** Rewrite one `KeyValue`: values of proof-relevant attributes are left alone. */
function rewriteKeyValue(buf: Buffer, start: number, end: number, mode: ObfuscationMode, depth: number): Buffer | null {
  const c: Cursor = { p: start };
  while (c.p < end) {
    const tag = readVarint(buf, c, end);
    if (tag === 10) {
      const len = readVarint(buf, c, end);
      if (c.p + len > end) throw new MalformedProtobuf('length');
      const name = buf.toString('utf8', c.p, c.p + len);
      if (PROOF_KEYS.has(name) && proofValueIsIdentifier(buf, c.p + len, end)) return null;
      if (PII_EXEMPT_KEYS.has(name) && valueIsPlainString(buf, c.p + len, end)) {
        // 'off' mode applies the secret patterns only, so the email stays but a smuggled secret is masked.
        return rewriteMessage(buf, start, end, 'kv', 'off', depth, true);
      }
      break;
    }
    skipPayload(buf, tag % 8, c, end);
  }
  return rewriteMessage(buf, start, end, 'kv', mode, depth, true);
}

/** True when the KeyValue's `AnyValue` (field 2) holds nothing but a `string_value`. */
function valueIsPlainString(buf: Buffer, from: number, end: number): boolean {
  const c: Cursor = { p: from };
  while (c.p < end) {
    const tag = readVarint(buf, c, end);
    if (tag !== 18) {
      skipPayload(buf, tag % 8, c, end);
      continue;
    }
    const len = readVarint(buf, c, end);
    if (c.p + len > end) throw new MalformedProtobuf('length');
    const inner: Cursor = { p: c.p };
    const innerEnd = c.p + len;
    if (inner.p >= innerEnd || readVarint(buf, inner, innerEnd) !== 10) return false;
    const innerLen = readVarint(buf, inner, innerEnd);
    return inner.p + innerLen === innerEnd;
  }
  return false;
}

/** True when the `AnyValue` string that follows the attribute name (KeyValue field 2) looks like an identifier. */
function proofValueIsIdentifier(buf: Buffer, from: number, end: number): boolean {
  const c: Cursor = { p: from };
  while (c.p < end) {
    const tag = readVarint(buf, c, end);
    if (tag % 8 !== 2) {
      skipPayload(buf, tag % 8, c, end);
      continue;
    }
    const len = readVarint(buf, c, end);
    if (c.p + len > end) throw new MalformedProtobuf('length');
    if (Math.floor(tag / 8) === 2) {
      // AnyValue.string_value is field 1: tag 10, length, bytes
      const inner: Cursor = { p: c.p };
      const innerEnd = c.p + len;
      while (inner.p < innerEnd) {
        const innerTag = readVarint(buf, inner, innerEnd);
        if (innerTag % 8 !== 2) {
          skipPayload(buf, innerTag % 8, inner, innerEnd);
          continue;
        }
        const innerLen = readVarint(buf, inner, innerEnd);
        if (inner.p + innerLen > innerEnd) throw new MalformedProtobuf('length');
        if (innerTag === 10) return IDENTIFIER_VALUE.test(buf.toString('utf8', inner.p, inner.p + innerLen));
        inner.p += innerLen;
      }
      return true;
    }
    c.p += len;
  }
  return true;
}

function skipPayload(buf: Buffer, wire: number, c: Cursor, end: number): void {
  if (wire === 0) readVarint(buf, c, end);
  else if (wire === 1) c.p += 8;
  else if (wire === 5) c.p += 4;
  else if (wire === 2) c.p += readVarint(buf, c, end);
  else throw new MalformedProtobuf('wire type');
  if (c.p > end) throw new MalformedProtobuf('length');
}

/** Returns the rewritten message payload, or null when no byte of it changes. */
function rewriteMessage(
  buf: Buffer,
  start: number,
  end: number,
  shapeName: string,
  mode: ObfuscationMode,
  depth: number,
  skipKeyValueCheck = false
): Buffer | null {
  if (depth > MAX_DEPTH) throw new MalformedProtobuf('depth');
  const shape = SHAPES[shapeName];
  if (shape.keyValue && !skipKeyValueCheck) return rewriteKeyValue(buf, start, end, mode, depth);

  const pieces: Buffer[] = [];
  let changed = false;
  let copyFrom = start;
  const c: Cursor = { p: start };
  while (c.p < end) {
    const fieldStart = c.p;
    const tag = readVarint(buf, c, end);
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (num === 0) throw new MalformedProtobuf('field number');
    const tagEnd = c.p;
    if (wire !== 2) {
      skipPayload(buf, wire, c, end);
      continue;
    }
    const len = readVarint(buf, c, end);
    const payloadStart = c.p;
    const payloadEnd = payloadStart + len;
    if (payloadEnd > end) throw new MalformedProtobuf('length');
    c.p = payloadEnd;

    let replacement: Buffer | null = null;
    if (shape.strings?.includes(num)) {
      replacement = sanitizeLeaf(buf, payloadStart, payloadEnd, mode);
    } else if (shape.kids && shape.kids[num] !== undefined) {
      replacement = rewriteMessage(buf, payloadStart, payloadEnd, shape.kids[num], mode, depth + 1);
    }
    if (replacement === null) continue;

    changed = true;
    pieces.push(buf.subarray(copyFrom, fieldStart), buf.subarray(fieldStart, tagEnd), encodeVarint(replacement.length), replacement);
    copyFrom = payloadEnd;
  }
  if (!changed) return null;
  pieces.push(buf.subarray(copyFrom, end));
  return Buffer.concat(pieces);
}

let droppedBodies = 0;
let lastDropWarnAt = 0;
const DROP_WARN_INTERVAL_MS = 60_000;

/** Count of bodies dropped so far (size limit or malformed); content-free. */
export function protobufObfuscationDropCount(): number {
  return droppedBodies;
}

export type ProtobufObfuscation =
  | { kind: 'ok'; body: Buffer }
  | { kind: 'dropped'; reason: 'too_large' | 'malformed' };

function drop(reason: 'too_large' | 'malformed'): ProtobufObfuscation {
  droppedBodies++;
  const now = Date.now();
  if (now - lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
    lastDropWarnAt = now;
    logger.warn(`[otlp-ingest] protobuf obfuscation dropped a body (${reason}); drops so far: ${droppedBodies}`);
  }
  return { kind: 'dropped', reason };
}

/**
 * Obfuscate the string leaves of one OTLP/protobuf export request. `ok` carries the same buffer when
 * nothing changes and the re-encoded buffer otherwise; `dropped` means the result would exceed the
 * forwarder's 5 MiB range limit, or (in `on` mode) the input is malformed and cannot be proven free
 * of sensitive strings. Strings that fail obfuscation become the failure placeholder; the rest of the body is kept.
 */
export function obfuscateOtlpProtobufResult(body: Buffer, mode: ObfuscationMode, signal: OtlpSignal): ProtobufObfuscation {
  let rewritten: Buffer | null;
  try {
    rewritten = rewriteMessage(body, 0, body.length, ROOT_BY_SIGNAL[signal], mode, 0);
  } catch (err) {
    if (err instanceof MalformedProtobuf && mode === 'off') return { kind: 'ok', body };
    return drop('malformed');
  }
  if (rewritten === null) return { kind: 'ok', body };
  if (rewritten.length > MAX_SNAPSHOT_BYTES) return drop('too_large');
  return { kind: 'ok', body: rewritten };
}

/** As `obfuscateOtlpProtobufResult`, with every drop reported as null. */
export function obfuscateOtlpProtobuf(body: Buffer, mode: ObfuscationMode, signal: OtlpSignal): Buffer | null {
  const result = obfuscateOtlpProtobufResult(body, mode, signal);
  return result.kind === 'ok' ? result.body : null;
}
