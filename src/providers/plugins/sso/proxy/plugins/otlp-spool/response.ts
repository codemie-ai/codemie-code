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

/** Read at most `max` bytes of the body, then cancel the rest. Never throws. */
export async function readBoundedBody(response: Response, max = MAX_RESPONSE_BYTES): Promise<Buffer> {
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      return typeof response.text === 'function' ? Buffer.from((await response.text()).slice(0, max)) : Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    if (size >= max) await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, max);
  } catch {
    return Buffer.alloc(0);
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

/** OTLP partial_success: protobuf, or JSON (camelCase or snake_case; int64 may be a string). */
function otlpPartial(body: Buffer, contentType: string): { rejected: number; message?: string } | undefined {
  if (contentType.toLowerCase().includes('json')) {
    const root = parseJson(body);
    const ps = (root?.['partialSuccess'] ?? root?.['partial_success']) as Record<string, unknown> | undefined;
    if (!ps || typeof ps !== 'object') return undefined;
    const key = Object.keys(ps).find((k) => k.startsWith('rejected'));
    const rejected = Number(key ? ps[key] : 0);
    return { rejected: Number.isFinite(rejected) ? rejected : 0, message: reasonOf(ps['errorMessage'] ?? ps['error_message']) };
  }
  const partial = protoFields(body)?.get(1);
  if (!Buffer.isBuffer(partial)) return undefined;
  const fields = protoFields(partial);
  const rejected = fields?.get(1);
  const message = fields?.get(2);
  return {
    rejected: typeof rejected === 'number' ? rejected : 0,
    message: Buffer.isBuffer(message) ? reasonOf(message.toString('utf-8')) : undefined,
  };
}

/** Typed outcome of a non-auth response. `hooks` = the event-hooks route (never an OTLP shape). */
export function decodeResponse(status: number, contentType: string, body: Buffer, hooks: boolean): SendOutcome {
  if (status === 409) {
    const json = parseJson(body);
    return json?.['reason'] === 'stale_policy'
      ? { kind: 'stale', reason: 'stale_policy', policyVersion: reasonOf(json['policy_version']) }
      : { kind: 'failed', reason: 'http_409' };
  }
  if (status >= 500) return { kind: 'retry', reason: `http_${status}` };
  if (status < 200 || status >= 300) return { kind: 'failed', reason: `http_${status}` };

  if (hooks) {
    const json = parseJson(body);
    const accepted = typeof json?.['accepted'] === 'number' ? json['accepted'] : undefined;
    const reason = reasonOf(json?.['reason']);
    return accepted === 0 && reason ? { kind: 'discarded', reason, accepted } : { kind: 'ok', accepted };
  }
  const partial = body.length > 0 ? otlpPartial(body, contentType) : undefined;
  if (partial && partial.rejected > 0) {
    return { kind: 'discarded', reason: partial.message ?? 'rejected', rejected: partial.rejected };
  }
  // rejected = 0 with a message is an OTLP warning: accepted, the message kept as the reason.
  return partial?.message ? { kind: 'ok', reason: partial.message } : { kind: 'ok' };
}
