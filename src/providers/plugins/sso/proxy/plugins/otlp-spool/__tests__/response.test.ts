import { describe, it, expect } from 'vitest';
import { decodeResponse, readBoundedBody, type BodyRead } from '../response.js';

const complete = (b: Buffer | string): BodyRead => ({ state: 'complete', bytes: Buffer.from(b) });
const PB = 'application/x-protobuf';

describe('readBoundedBody', () => {
  it('reports a read that throws as failed, never an empty complete body', async () => {
    const res = { body: { getReader: () => ({ read: async () => { throw new Error('connection reset'); } }) } } as unknown as Response;
    expect((await readBoundedBody(res)).state).toBe('failed');
  });

  it('reports a body over the cap as truncated and cancels the rest', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(40);
    const res = {
      body: { getReader: () => ({ read: async () => ({ done: false, value: chunk }), cancel: async () => { cancelled = true; } }) },
    } as unknown as Response;
    const read = await readBoundedBody(res, 100);
    expect(read.state).toBe('truncated');
    expect(read.bytes.length).toBe(100);
    expect(cancelled).toBe(true);
  });

  it('reads a body at exactly the cap as complete; the text() fallback is bounded too', async () => {
    expect((await readBoundedBody(new Response('x'.repeat(50)), 50)).state).toBe('complete');
    expect((await readBoundedBody({ text: async () => 'x'.repeat(80) } as unknown as Response, 50)).state).toBe('truncated');
  });
});

describe('decodeResponse: unverified 2xx responses are never acknowledged', () => {
  it('hooks: malformed JSON, non-object, wrong field types', () => {
    for (const body of ['not-json', '[]', '{"accepted":"1"}', '{"accepted":-1}', '{"reason":5}', '']) {
      expect(decodeResponse(200, 'application/json', complete(body), true)).toEqual({ kind: 'failed', reason: 'response_malformed' });
    }
  });

  it('hooks: {} and the discard shape stay valid', () => {
    expect(decodeResponse(200, 'application/json', complete('{}'), true)).toEqual({ kind: 'ok', accepted: undefined });
    expect(decodeResponse(200, 'application/json', complete('{"accepted":0,"dropped":2,"reason":"session_project_conflict"}'), true))
      .toEqual({ kind: 'discarded', reason: 'session_project_conflict', accepted: 0 });
  });

  it('OTLP: truncated protobuf is malformed (the probe case [0x0a,0x7f]); a genuinely empty body is ok', () => {
    expect(decodeResponse(200, PB, complete(Buffer.from([0x0a, 0x7f])), false)).toEqual({ kind: 'failed', reason: 'response_malformed' });
    expect(decodeResponse(200, PB, complete(''), false)).toEqual({ kind: 'ok' });
  });

  it('OTLP: malformed JSON and a wrong partial_success shape are malformed; a valid empty JSON object is ok', () => {
    expect(decodeResponse(200, 'application/json', complete('{'), false)).toEqual({ kind: 'failed', reason: 'response_malformed' });
    expect(decodeResponse(200, 'application/json', complete('{"partialSuccess":3}'), false)).toEqual({ kind: 'failed', reason: 'response_malformed' });
    expect(decodeResponse(200, 'application/json', complete('{"partialSuccess":{"rejectedLogRecords":"x"}}'), false))
      .toEqual({ kind: 'failed', reason: 'response_malformed' });
    expect(decodeResponse(200, 'application/json', complete('{}'), false)).toEqual({ kind: 'ok' });
  });

  it('OTLP: rejected count and message are decoded together (JSON and protobuf)', () => {
    expect(decodeResponse(200, 'application/json', complete('{"partialSuccess":{"rejectedSpans":"3","errorMessage":"bad"}}'), false))
      .toEqual({ kind: 'discarded', reason: 'bad', rejected: 3 });
    const msg = Buffer.from('nope');
    const inner = Buffer.concat([Buffer.from([0x08, 2, 0x12, msg.length]), msg]);
    expect(decodeResponse(200, PB, complete(Buffer.concat([Buffer.from([0x0a, inner.length]), inner])), false))
      .toEqual({ kind: 'discarded', reason: 'nope', rejected: 2 });
  });

  it('a body read failure (reset / timeout after headers) retries; an oversized body fails with its own reason; neither acknowledges', () => {
    expect(decodeResponse(200, PB, { state: 'failed', bytes: Buffer.alloc(0) }, false)).toEqual({ kind: 'retry', reason: 'response_read_failed' });
    expect(decodeResponse(200, PB, { state: 'truncated', bytes: Buffer.alloc(0) }, true)).toEqual({ kind: 'failed', reason: 'response_too_large' });
  });
});
