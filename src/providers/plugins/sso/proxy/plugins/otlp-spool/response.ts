/**
 * The single response consumer of a forward (spec item 9): one bounded body read, decoded into a
 * typed outcome. Backend contract (cli-analytics-events.md, ingestor.py): hooks answer `{}` or
 * `{"accepted":0,"dropped":N,"reason":...}`; OTLP answers an Export*ServiceResponse whose
 * `partial_success` {rejected_* = 1, error_message = 2} names rejected records; a stale policy is
 * 409 `{"reason":"stale_policy","policy_version":...}`.
 */

export type SendKind = 'ok' | 'discarded' | 'stale' | 'retry' | 'failed' | 'auth-expired';

export interface SendOutcome {
  kind: SendKind;
  reason?: string;
  accepted?: number;
  /** OTLP: records the backend rejected (final; the range is still acknowledged). */
  rejected?: number;
  /** 409 stale_policy: the backend's current policy version. */
  policyVersion?: string;
}

export const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REASON = 200;

/** A bounded body read: how it ended, never a silent empty body. */
export interface BodyRead {
  /** complete = whole body read; truncated = more than `max` bytes; failed = the read threw (reset, timeout, abort). */
  state: 'complete' | 'truncated' | 'failed';
  bytes: Buffer;
}

/** Read at most `max` bytes of the body, then cancel the rest. Never throws; reports how the read ended. */
export async function readBoundedBody(response: Response, max = MAX_RESPONSE_BYTES): Promise<BodyRead> {
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      if (typeof response.text !== 'function') return { state: 'complete', bytes: Buffer.alloc(0) };
      const whole = Buffer.from(await response.text());
      return whole.length > max ? { state: 'truncated', bytes: whole.subarray(0, max) } : { state: 'complete', bytes: whole };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { state: 'complete', bytes: Buffer.concat(chunks) };
      chunks.push(Buffer.from(value));
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return { state: 'truncated', bytes: Buffer.concat(chunks).subarray(0, max) };
      }
    }
  } catch {
    return { state: 'failed', bytes: Buffer.alloc(0) };
  }
}

const reasonOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_REASON) : undefined;

function parseJson(body: Buffer): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(body.toString('utf-8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal protobuf walk: returns field -> varint number or length-delimited bytes (last wins). */
function protoFields(buf: Buffer): Map<number, number | Buffer> | undefined {
  const out = new Map<number, number | Buffer>();
  let pos = 0;
  const varint = (): number => {
    let result = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (pos >= buf.length) throw new RangeError('truncated');
      const b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
    }
    throw new RangeError('varint');
  };
  try {
    while (pos < buf.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (wire === 0) out.set(field, varint());
      else if (wire === 2) {
        const len = varint();
        if (pos + len > buf.length) return undefined;
        out.set(field, buf.subarray(pos, pos + len));
        pos += len;
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else return undefined;
    }
    return pos === buf.length ? out : undefined;
  } catch {
    return undefined;
  }
}

type Partial = { rejected: number; message?: string };

/**
 * OTLP partial_success: protobuf, or JSON (camelCase or snake_case; int64 may be a string).
 * `null` = a well-formed response without one; `'malformed'` = not a decodable Export*ServiceResponse.
 */
function otlpPartial(body: Buffer, contentType: string): Partial | null | 'malformed' {
  if (contentType.toLowerCase().includes('json')) {
    const root = parseJson(body);
    if (!root) return 'malformed';
    const ps = root['partialSuccess'] ?? root['partial_success'];
    if (ps === undefined || ps === null) return null;
    if (typeof ps !== 'object' || Array.isArray(ps)) return 'malformed';
    const rec = ps as Record<string, unknown>;
    const key = Object.keys(rec).find((k) => k.startsWith('rejected'));
    const rejected = key === undefined ? 0 : Number(rec[key]);
    if (!Number.isFinite(rejected) || rejected < 0) return 'malformed';
    return { rejected, message: reasonOf(rec['errorMessage'] ?? rec['error_message']) };
  }
  const top = protoFields(body);
  if (!top) return 'malformed';
  const partial = top.get(1);
  if (partial === undefined) return null;
  if (!Buffer.isBuffer(partial)) return 'malformed';
  const fields = protoFields(partial);
  if (!fields) return 'malformed';
  const rejected = fields.get(1);
  const message = fields.get(2);
  if ((rejected !== undefined && typeof rejected !== 'number') || (message !== undefined && !Buffer.isBuffer(message))) return 'malformed';
  return { rejected: rejected ?? 0, message: message ? reasonOf(message.toString('utf-8')) : undefined };
}

/** Typed outcome of a non-auth response. `hooks` = the event-hooks route (never an OTLP shape). */
export function decodeResponse(status: number, contentType: string, body: BodyRead, hooks: boolean): SendOutcome {
  if (status === 409) {
    const json = parseJson(body.bytes);
    return json?.['reason'] === 'stale_policy'
      ? { kind: 'stale', reason: 'stale_policy', policyVersion: reasonOf(json['policy_version']) }
      : { kind: 'failed', reason: 'http_409' };
  }
  if (status >= 500) return { kind: 'retry', reason: `http_${status}` };
  if (status < 200 || status >= 300) return { kind: 'failed', reason: `http_${status}` };

  // A 2xx whose body cannot be verified is not an acknowledgement: the range stays (at-least-once).
  if (body.state === 'failed') return { kind: 'retry', reason: 'response_read_failed' };
  if (body.state === 'truncated') return { kind: 'failed', reason: 'response_too_large' };

  if (hooks) {
    const json = parseJson(body.bytes);
    if (!json) return { kind: 'failed', reason: 'response_malformed' };
    const { accepted, dropped, reason } = json as Record<string, unknown>;
    const countOk = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
    if (!countOk(accepted) || !countOk(dropped) || (reason !== undefined && typeof reason !== 'string')) {
      return { kind: 'failed', reason: 'response_malformed' };
    }
    const why = reasonOf(reason);
    return accepted === 0 && why ? { kind: 'discarded', reason: why, accepted } : { kind: 'ok', accepted: accepted as number | undefined };
  }
  if (body.bytes.length === 0) return { kind: 'ok' }; // a genuine empty Export*ServiceResponse
  const partial = otlpPartial(body.bytes, contentType);
  if (partial === 'malformed') return { kind: 'failed', reason: 'response_malformed' };
  if (partial && partial.rejected > 0) {
    return { kind: 'discarded', reason: partial.message ?? 'rejected', rejected: partial.rejected };
  }
  // rejected = 0 with a message is an OTLP warning: accepted, the message kept as the reason.
  return partial?.message ? { kind: 'ok', reason: partial.message } : { kind: 'ok' };
}
