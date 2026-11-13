import { describe, expect, it } from 'vitest';
import { proveJsonRecord } from '../otlp-json-reader.js';

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const target = { sessionId: 's1', project: 'p', signal: 'logs' as const };
const logs = (ids: string[], project = 'p') => JSON.stringify({ resourceLogs: [{
  resource: { attributes: [attr('codemie_project_name', project)] },
  scopeLogs: [{ logRecords: ids.map(id => ({ attributes: [attr('session.id', id)] })) }],
}] });

describe('OTLP JSON evidence proof', () => {
  it('proves all records and resource project without changing bytes', () => {
    const record = logs(['s1', 's1']);
    expect(proveJsonRecord(record, target)).toEqual({ verified: Buffer.byteLength(record) });
  });
  it.each([
    [logs(['s1', 'other']), 'session_mismatch'],
    [logs(['s1'], 'other'), 'project_conflict'],
    [logs(['s1']), 'project_conflict', undefined],
    ['{"resourceLogs":[{"scopeLogs":[{"logRecords":[{}]}]}]}', 'session_id_absent'],
    ['{"resourceLogs":{}}', 'otlp_unparseable'],
    ['invalid', 'otlp_unparseable'],
  ])('holds a whole invalid record: %s', (record, hold, ...project) => {
    expect(proveJsonRecord(record as string, { ...target, ...(project.length ? { project: project[0] } : {}) }))
      .toEqual({ verified: 0, hold });
  });
  it('checks every metrics point, not only the first', () => {
    const record = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ sum: {
      dataPoints: [{ attributes: [attr('session.id', 's1')] }, { attributes: [attr('session.id', 'other')] }],
    } }] }] }] });
    expect(proveJsonRecord(record, { ...target, signal: 'metrics' })).toEqual({ verified: 0, hold: 'session_mismatch' });
  });
  it('supports snake-case trace fields and ignores resource session as a unit source', () => {
    const record = JSON.stringify({ resource_spans: [{ resource: { attributes: [attr('session.id', 's1')] },
      scope_spans: [{ spans: [{ attributes: [attr('session.id', 's1')] }] }],
    }] });
    expect(proveJsonRecord(record, { ...target, signal: 'traces' }).hold).toBeUndefined();
    expect(proveJsonRecord(record.replace('"spans":[{"attributes":[{"key":"session.id","value":{"stringValue":"s1"}}]}]', '"spans":[{}]'),
      { ...target, signal: 'traces' }).hold).toBe('session_id_absent');
  });
});
