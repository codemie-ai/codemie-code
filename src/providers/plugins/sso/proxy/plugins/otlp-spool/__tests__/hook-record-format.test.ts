import { describe, it, expect } from 'vitest';
import {
  addLineId,
  encodeHookRecord,
  hookRecordEventId,
  lineIdOf,
  parseHookEnvelope,
  setUserEmail,
} from '../hook-record-format.js';
import { unwrapHookRecords } from '../forwarder.js';

const NOW = 1_764_000_000_000;

interface Decoded {
  resourceLogs: {
    resource: { attributes: { key: string; value: unknown }[] };
    scopeLogs: {
      scope: { name: string; attributes?: { key: string; value: unknown }[] };
      logRecords: { timeUnixNano: string; eventName: string; attributes: { key: string; value: unknown }[] }[];
    }[];
  }[];
}

function decode(line: string | null): Decoded {
  expect(line).not.toBeNull();
  return JSON.parse(line as string) as Decoded;
}

function record(line: string | null) {
  return decode(line).resourceLogs[0].scopeLogs[0].logRecords[0];
}

function attr(line: string | null, key: string): unknown {
  return record(line).attributes.find((a) => a.key === key)?.value;
}

describe('encodeHookRecord — values', () => {
  it('maps every value class to its OTLP AnyValue', () => {
    const line = encodeHookRecord(
      {
        type: 'agent.tool.end',
        s: 'text',
        b: false,
        i: 42,
        neg: -7,
        d: 1.5,
        maxInt: 2 ** 63 - 1024,
        minInt: -(2 ** 63),
        overMax: 2 ** 63,
        underMin: -(2 ** 63) - 2048,
        arr: [1, 'two', null],
        obj: { z: 1, a: 'x' },
        nil: null,
        undef: undefined,
        fn: () => 1,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        holes: [undefined, Number.NaN],
      },
      { nowMs: NOW }
    );
    expect(record(line).attributes).toEqual([
      { key: 'event_type', value: { stringValue: 'agent.tool.end' } },
      { key: 's', value: { stringValue: 'text' } },
      { key: 'b', value: { boolValue: false } },
      { key: 'i', value: { intValue: '42' } },
      { key: 'neg', value: { intValue: '-7' } },
      { key: 'd', value: { doubleValue: 1.5 } },
      { key: 'maxInt', value: { intValue: '9223372036854774784' } },
      { key: 'minInt', value: { intValue: '-9223372036854775808' } },
      { key: 'overMax', value: { doubleValue: 9223372036854775808 } },
      { key: 'underMin', value: { doubleValue: -9223372036854777856 } },
      { key: 'arr', value: { arrayValue: { values: [{ intValue: '1' }, { stringValue: 'two' }, {}] } } },
      {
        key: 'obj',
        value: { kvlistValue: { values: [{ key: 'z', value: { intValue: '1' } }, { key: 'a', value: { stringValue: 'x' } }] } },
      },
      { key: 'nil', value: {} },
      { key: 'nan', value: {} },
      { key: 'inf', value: {} },
      { key: 'holes', value: { arrayValue: { values: [{}, {}] } } },
    ]);
  });

  it('carries a container nested deeper than 16 levels as its compact JSON text', () => {
    // 17 nested objects: levels 1..16 stay structured, the 17th is text.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 16; i++) deep = { n: deep };
    const line = encodeHookRecord({ type: 't', deep }, { nowMs: NOW });

    let value = attr(line, 'deep') as { kvlistValue?: { values: { value: unknown }[] }; stringValue?: string };
    for (let level = 1; level <= 16; level++) {
      expect(value.kvlistValue).toBeDefined();
      value = value.kvlistValue!.values[0].value as typeof value;
    }
    expect(value).toEqual({ stringValue: '{"leaf":true}' });
  });
});

describe('encodeHookRecord — shape', () => {
  it('writes type twice, user.email last, the resource and the scope', () => {
    const line = encodeHookRecord(
      { session_id: 's1', type: 'agent.session.start', user_email: 'dev@example.com', timestamp: '2026-11-25T10:00:00.123Z' },
      { nowMs: NOW }
    );
    const decoded = decode(line);
    const logRecord = record(line);
    expect(logRecord.eventName).toBe('agent.session.start');
    expect(logRecord.attributes.map((a) => a.key)).toEqual(['session_id', 'event_type', 'user_email', 'timestamp', 'user.email']);
    expect(logRecord.attributes[4]).toEqual({ key: 'user.email', value: { stringValue: 'dev@example.com' } });
    expect(logRecord.timeUnixNano).toBe('1795600800123000000');
    expect(logRecord.timeUnixNano).toMatch(/^\d+$/);
    expect(decoded.resourceLogs[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'codemie-cli' } }]);
    expect(decoded.resourceLogs[0].scopeLogs[0].scope).toEqual({ name: 'codemie.hooks' });
  });

  it('puts the evidence marker on the scope and the line id on the resource only when given', () => {
    const line = encodeHookRecord({ type: 't' }, { evidenceV: 1, lineId: 's1.hooks.jsonl:120', nowMs: NOW });
    const decoded = decode(line);
    expect(decoded.resourceLogs[0].scopeLogs[0].scope).toEqual({
      name: 'codemie.hooks',
      attributes: [{ key: 'codemie.evidence_v', value: { intValue: '1' } }],
    });
    expect(decoded.resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'codemie-cli' } },
      { key: 'codemie.line_id', value: { stringValue: 's1.hooks.jsonl:120' } },
    ]);
  });

  it('writes no user.email for an empty user_email and drops the reserved keys', () => {
    const line = encodeHookRecord(
      { type: 't', user_email: '', event_type: 'x', 'user.email': 'y', 'session.id': 'z', 'prompt.id': 'w', keep: 1 },
      { nowMs: NOW }
    );
    expect(record(line).attributes).toEqual([
      { key: 'event_type', value: { stringValue: 't' } },
      { key: 'user_email', value: { stringValue: '' } },
      { key: 'keep', value: { intValue: '1' } },
    ]);
  });

  it('answers null for an event without a non-empty type', () => {
    expect(encodeHookRecord({ session_id: 's1' }, { nowMs: NOW })).toBeNull();
    expect(encodeHookRecord({ type: '' }, { nowMs: NOW })).toBeNull();
    expect(encodeHookRecord({ type: 7 }, { nowMs: NOW })).toBeNull();
  });

  it('takes nowMs for an unparsable or numeric timestamp, and repeats its bytes', () => {
    expect(record(encodeHookRecord({ type: 't', timestamp: 'not a date' }, { nowMs: NOW })).timeUnixNano).toBe('1764000000000000000');
    expect(record(encodeHookRecord({ type: 't', timestamp: 1 }, { nowMs: NOW })).timeUnixNano).toBe('1764000000000000000');
    expect(attr(encodeHookRecord({ type: 't', timestamp: 1 }, { nowMs: NOW }), 'timestamp')).toEqual({ intValue: '1' });
    const event = { type: 't', a: { b: 1 } };
    expect(encodeHookRecord(event, { nowMs: NOW })).toBe(encodeHookRecord(event, { nowMs: NOW }));
  });
});

describe('hookRecordEventId', () => {
  it('reads the event_id of an encoded record', () => {
    expect(hookRecordEventId(encodeHookRecord({ type: 't', event_id: 'e-1' }, { nowMs: NOW })!)).toBe('e-1');
    expect(hookRecordEventId(encodeHookRecord({ type: 't' }, { nowMs: NOW })!)).toBeUndefined();
    expect(hookRecordEventId('{"resourceSpans":[{"resource":{},"scopeSpans":[]}]}')).toBeUndefined();
    expect(hookRecordEventId('not json')).toBeUndefined();
  });
});

describe('parseHookEnvelope', () => {
  it('keeps evidence_v and the raw hookEvent', () => {
    const raw = '{"type":"t", "a" :1}';
    expect(parseHookEnvelope(JSON.stringify({ agentName: 'claude', hookEvent: raw, evidence_v: 1 }))).toEqual({
      event: { type: 't', a: 1 },
      raw,
      evidenceV: 1,
    });
    expect(parseHookEnvelope(JSON.stringify({ agentName: 'claude', hookEvent: raw }))).toEqual({ event: { type: 't', a: 1 }, raw });
  });

  it('answers null for a broken envelope or a broken hookEvent', () => {
    expect(parseHookEnvelope('{"agentName":')).toBeNull();
    expect(parseHookEnvelope(JSON.stringify({ agentName: 'claude', hookEvent: '{"type":' }))).toBeNull();
  });

  it('lets unwrapHookRecords forward the hookEvent bytes unchanged', () => {
    const raw = '{ "type" :  "agent.tool.end",\t"session_id":"s1" }';
    expect(unwrapHookRecords([JSON.stringify({ agentName: 'claude', hookEvent: raw })]).ndjson).toBe(`${raw}\n`);
  });
});

describe('addLineId', () => {
  it('adds the id to every resource, creating attributes where absent', () => {
    const line = JSON.stringify({
      resourceLogs: [
        { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] }, scopeLogs: [] },
        { resource: {}, scopeLogs: [] },
      ],
    });
    expect(JSON.parse(addLineId(line, 'f.jsonl:0')!)).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'claude-code' } },
              { key: 'codemie.line_id', value: { stringValue: 'f.jsonl:0' } },
            ],
          },
          scopeLogs: [],
        },
        { resource: { attributes: [{ key: 'codemie.line_id', value: { stringValue: 'f.jsonl:0' } }] }, scopeLogs: [] },
      ],
    });
  });

  it('adds the id to every resource of a snake_case export', () => {
    const line = JSON.stringify({
      resource_logs: [
        { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] }, scope_logs: [] },
        { scope_logs: [] },
      ],
    });
    expect(JSON.parse(addLineId(line, 'f.jsonl:0')!)).toEqual({
      resource_logs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'claude-code' } },
              { key: 'codemie.line_id', value: { stringValue: 'f.jsonl:0' } },
            ],
          },
          scope_logs: [],
        },
        { scope_logs: [], resource: { attributes: [{ key: 'codemie.line_id', value: { stringValue: 'f.jsonl:0' } }] } },
      ],
    });
  });

  it('answers null for a line that does not parse', () => {
    expect(addLineId('not json', 'f.jsonl:0')).toBeNull();
  });
});

describe('setUserEmail', () => {
  const lineId = { key: 'codemie.line_id', value: { stringValue: 'f.jsonl:0' } };
  const email = (value: string) => ({ key: 'user.email', value: { stringValue: value } });
  const record = { attributes: [email('rec@example.com'), { key: 'event_type', value: { stringValue: 'x' } }] };

  it('sets the email on every resource, replacing a resource-level one, records untouched', () => {
    const line = JSON.stringify({
      resourceLogs: [
        { resource: { attributes: [email('old@example.com'), lineId] }, scopeLogs: [{ logRecords: [record] }] },
        { scopeLogs: [] },
      ],
    });
    expect(JSON.parse(setUserEmail(line, 'A.B@Example.com')!)).toEqual({
      resourceLogs: [
        { resource: { attributes: [lineId, email('A.B@Example.com')] }, scopeLogs: [{ logRecords: [record] }] },
        { scopeLogs: [], resource: { attributes: [email('A.B@Example.com')] } },
      ],
    });
  });

  it('sets the email on every resource of a snake_case export', () => {
    const line = JSON.stringify({ resource_spans: [{ resource: { attributes: [lineId] }, scope_spans: [] }] });
    expect(JSON.parse(setUserEmail(line, 'A.B@Example.com')!)).toEqual({
      resource_spans: [{ resource: { attributes: [lineId, email('A.B@Example.com')] }, scope_spans: [] }],
    });
  });

  it('answers null for a line that does not parse or is not an export request', () => {
    expect(setUserEmail('not json', 'a@example.com')).toBeNull();
    expect(setUserEmail('{"other":[]}', 'a@example.com')).toBeNull();
  });
});

describe('lineIdOf', () => {
  const LINE = '{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[]}]}';

  it('is the file name and 32 hex digits', () => {
    expect(lineIdOf('s1.otel_logs.jsonl', LINE)).toMatch(/^s1\.otel_logs\.jsonl:[0-9a-f]{32}$/);
  });

  it('is the same for the same line', () => {
    expect(lineIdOf('s1.otel_logs.jsonl', LINE)).toBe(lineIdOf('s1.otel_logs.jsonl', LINE));
  });

  it('differs for two lines that differ in one byte', () => {
    expect(lineIdOf('s1.otel_logs.jsonl', LINE)).not.toBe(lineIdOf('s1.otel_logs.jsonl', LINE.replace('[]}', '[ }')));
  });

  it('differs for the same line under two file names', () => {
    expect(lineIdOf('s1.otel_logs.jsonl', LINE)).not.toBe(lineIdOf('s2.otel_logs.jsonl', LINE));
  });
});
