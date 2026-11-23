/**
 * `obfuscateOtlpProtobuf`: byte-faithful rewrite of string AnyValue leaves in an OTLP/protobuf export.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { obfuscateOtlpProtobuf, obfuscateOtlpProtobufResult } from '../otlp-protobuf-obfuscate.js';
import { proveRange, MAX_SNAPSHOT_BYTES } from '../otlp-spool/otlp-reader.js';
import { OBFUSCATION_FAILURE_PLACEHOLDER } from '@/utils/analytics-obfuscation.js';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}
const ld = (num: number, payload: Buffer | string): Buffer => {
  const p = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([varint(num * 8 + 2), varint(p.length), p]);
};
const vint = (num: number, n: number): Buffer => Buffer.concat([varint(num * 8), varint(n)]);
const anyStr = (s: string): Buffer => ld(1, s);
const attr6 = (key: string, value: Buffer): Buffer => ld(6, Buffer.concat([ld(1, key), ld(2, value)]));
function logs(body: string, extra: Buffer[] = [], unknown: Buffer = Buffer.alloc(0)): Buffer {
  const record = Buffer.concat([
    ld(5, anyStr(body)),
    attr6('session.id', anyStr(SESSION)),
    ...extra,
    unknown,
  ]);
  return ld(1, ld(2, ld(2, record)));
}
describe('obfuscateOtlpProtobuf', () => {
  it('returns the identical buffer when nothing is sensitive', () => {
    const body = logs('hello world');
    const out = obfuscateOtlpProtobuf(body, 'on', 'logs');
    expect(out).toBe(body);
  });

  it('keeps unknown fields byte for byte', () => {
    const unknown = Buffer.concat([vint(99, 12345), ld(98, Buffer.from([1, 2, 3, 0xff]))]);
    const out = obfuscateOtlpProtobuf(logs('mail me at john.doe@example.com', [], unknown), 'on', 'logs');
    expect(out).not.toBeNull();
    expect(out!.includes(unknown)).toBe(true);
    expect(out!.includes(Buffer.from('john.doe@example.com'))).toBe(false);
  });

  it('replaces an email and passes the forwarder range proof', () => {
    const body = logs('contact john.doe@example.com now');
    const out = obfuscateOtlpProtobuf(body, 'on', 'logs')!;
    expect(out.equals(body)).toBe(false);
    expect(out.toString('utf8')).not.toContain('john.doe@example.com');
    const proof = proveRange(out, { sessionId: SESSION, signal: 'logs' });
    expect(proof.hold).toBeUndefined();
    expect(proof.verified).toBe(out.length);
  });

  it('keeps the user.email attribute while a prompt attribute holding an email is still masked', () => {
    const body = logs('hi', [attr6('user.email', anyStr('dev@example.com')), attr6('prompt', anyStr('write to dev@example.com'))]);
    const out = obfuscateOtlpProtobuf(body, 'on', 'logs')!.toString('utf8');
    expect(out.match(/dev@example\.com/g)).toHaveLength(1);
    expect(out).toContain('write to [REDACTED:EMAIL]');
  });

  it('rewrites string attribute values and nested kvlist values', () => {
    const nested = Buffer.concat([ld(6, ld(1, Buffer.concat([ld(1, 'inner'), ld(2, anyStr('a@b.io'))])))]);
    const out = obfuscateOtlpProtobuf(
      logs('x', [attr6('email', anyStr('jane@corp.com')), attr6('obj', nested)]),
      'on',
      'logs'
    )!;
    const text = out.toString('utf8');
    expect(text).not.toContain('jane@corp.com');
    expect(text).not.toContain('a@b.io');
    expect(proveRange(out, { sessionId: SESSION, signal: 'logs' }).hold).toBeUndefined();
  });

  it('does not touch metric values or non-string leaves', () => {
    const body = logs('x', [attr6('count', Buffer.concat([vint(3, 42)]))]);
    expect(obfuscateOtlpProtobuf(body, 'on', 'logs')).toBe(body);
  });

  it('turns a string over the input cap into the placeholder and keeps the rest', () => {
    const big = 'a'.repeat(300 * 1024);
    const body = logs(big, [attr6('count', vint(3, 42)), attr6('who', anyStr('x@y.com'))]);
    const out = obfuscateOtlpProtobuf(body, 'on', 'logs')!;
    const text = out.toString('utf8');
    expect(text).toContain(OBFUSCATION_FAILURE_PLACEHOLDER);
    expect(text).not.toContain('aaaaaaaaaa');
    expect(out.includes(vint(3, 42))).toBe(true);
    expect(proveRange(out, { sessionId: SESSION, signal: 'logs' }).hold).toBeUndefined();
  });

  it('returns null for malformed input in on mode', () => {
    const bad = Buffer.concat([logs('x'), Buffer.from([0x0a, 0x7f, 0x01])]);
    expect(obfuscateOtlpProtobuf(bad, 'on', 'logs')).toBeNull();
  });

  it('walks traces span names, attributes and events', () => {
    const span = Buffer.concat([
      ld(5, 'call bob@x.org'),
      ld(9, Buffer.concat([ld(1, 'k'), ld(2, anyStr('carol@x.org'))])),
      ld(11, Buffer.concat([ld(2, 'ev dave@x.org')])),
    ]);
    const body = ld(1, ld(2, ld(2, span)));
    const out = obfuscateOtlpProtobuf(body, 'on', 'traces')!;
    const text = out.toString('utf8');
    for (const e of ['bob@x.org', 'carol@x.org', 'dave@x.org']) expect(text).not.toContain(e);
  });

  it('walks metric data point attributes', () => {
    const point = ld(7, Buffer.concat([ld(1, 'u'), ld(2, anyStr('erin@x.org'))]));
    const metric = Buffer.concat([ld(1, 'm'), ld(7, ld(1, point))]);
    const body = ld(1, ld(2, ld(2, metric)));
    const out = obfuscateOtlpProtobuf(body, 'on', 'metrics')!;
    expect(out.toString('utf8')).not.toContain('erin@x.org');
  });

  it('handles a body near 5 MiB: forwarded within the limit or dropped', () => {
    const chunk = 'word '.repeat(40 * 1024); // ~200 KB each, under the input cap
    const attrs: Buffer[] = [];
    while (attrs.reduce((n, a) => n + a.length, 0) < MAX_SNAPSHOT_BYTES - 400 * 1024) {
      attrs.push(attr6('t', anyStr(chunk)));
    }
    attrs.push(attr6('e', anyStr('frank@example.com')));
    const body = logs('x', attrs);
    expect(body.length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    const out = obfuscateOtlpProtobuf(body, 'on', 'logs');
    if (out !== null) {
      expect(out.length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
      expect(out.toString('utf8')).not.toContain('frank@example.com');
    }
  });

  it('drops a body whose re-encoding exceeds the limit', () => {
    // Each short email grows into a longer placeholder, pushing the body over 5 MiB.
    const attrs: Buffer[] = [];
    const email = anyStr('a@b.co');
    const per = attr6('e', email).length;
    const n = Math.floor((MAX_SNAPSHOT_BYTES - 1000) / per);
    for (let i = 0; i < n; i++) attrs.push(attr6('e', email));
    const body = logs('x', attrs);
    expect(body.length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(obfuscateOtlpProtobuf(body, 'on', 'logs')).toBeNull();
  });
});

describe('obfuscateOtlpProtobufResult', () => {
  it('reports a malformed body as dropped with its reason', () => {
    const bad = Buffer.concat([logs('x'), Buffer.from([0x0a, 0x7f, 0x01])]);
    expect(obfuscateOtlpProtobufResult(bad, 'on', 'logs')).toEqual({ kind: 'dropped', reason: 'malformed' });
  });

  it('obfuscates a session.id attribute whose value is free text, not an identifier', () => {
    const body = ld(1, ld(2, ld(2, Buffer.concat([ld(5, anyStr('x')), attr6('session.id', anyStr('mail bob@example.com please'))]))));
    const result = obfuscateOtlpProtobufResult(body, 'on', 'logs');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.body.toString('latin1')).not.toContain('bob@example.com');
  });

  it('replaces a leaf that is not valid UTF-8 with the failure placeholder', () => {
    const body = ld(1, ld(2, ld(2, Ld5(Buffer.from([0x61, 0xff, 0xfe, 0x62])))));
    const result = obfuscateOtlpProtobufResult(body, 'on', 'logs');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.body.includes(Buffer.from(OBFUSCATION_FAILURE_PLACEHOLDER))).toBe(true);
  });

  it('obfuscates the event name of a log record', () => {
    const body = ld(1, ld(2, ld(2, Buffer.concat([ld(5, anyStr('x')), ld(12, 'event for bob@example.com')]))));
    const result = obfuscateOtlpProtobufResult(body, 'on', 'logs');
    expect(result.kind === 'ok' && result.body.toString('latin1')).not.toContain('bob@example.com');
  });
});
function Ld5(payload: Buffer): Buffer {
  return ld(5, ld(1, payload));
}
