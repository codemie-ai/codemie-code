import { describe, expect, it } from 'vitest';
import { reduceOtlpJsonRecord } from '../otlp-json-reduction.js';

describe('reduceOtlpJsonRecord free text outside KeyValue nodes (CR-004)', () => {
  it('replaces description, status message, severity text, a string body and a free-text span name', () => {
    const record = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ scope: { name: 'client.scope' }, spans: [{
        name: 'secret client plan', status: { message: 'failed for acme' }, events: [{ name: 'tool_use', attributes: [] }],
      }] }] }],
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', description: 'free text here' }] }] }],
      logRecords: [{ body: 'raw prompt text', severityText: 'INFO and secret' }],
    });
    const out = reduceOtlpJsonRecord(record) as string;
    expect(out).not.toContain('secret');
    expect(out).not.toContain('acme');
    expect(out).not.toContain('free text');
    expect(out).not.toContain('raw prompt');
    expect(out).toContain('claude_code.token.usage');
    expect(out).toContain('tool_use');
    expect(out).toContain('client.scope');
  });
});

describe('reduceOtlpJsonRecord replaces unknown strings by default (CR-021)', () => {
  it('replaces a string field the exporter adds later but keeps ids, timestamps and units', () => {
    const record = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', startTimeUnixNano: '1700000000000000000',
        futureNote: 'summary of the acme migration', traceState: 'vendor=acme-secret',
      }] }] }],
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', unit: 'tokens' }] }] }],
    });
    const out = reduceOtlpJsonRecord(record) as string;
    expect(out).not.toContain('acme');
    expect(out).toContain('0af7651916cd43dd8448eb211c80319c');
    expect(out).toContain('1700000000000000000');
    expect(out).toContain('"unit":"tokens"');
    expect(out).toContain('REDACTED:FUTURE-NOTE');
  });

  it('replaces a structural field that holds prose instead of an id', () => {
    const out = reduceOtlpJsonRecord(JSON.stringify({ spans: [{ spanId: 'the acme plan is to migrate' }] })) as string;
    expect(out).not.toContain('acme');
    expect(out).toContain('REDACTED:SPAN-ID');
  });
});

describe('native attributes keep command, skill and agent names (CR-022)', () => {
  it('keeps names on the attribute keep-list and redacts an unlisted attribute', () => {
    const attr = (key: string, v: string) => ({ key, value: { stringValue: v } });
    const out = reduceOtlpJsonRecord(JSON.stringify({
      logRecords: [{ attributes: [attr('skill_name', 'commit'), attr('command_name', 'review-pr'), attr('prompt', 'private text')] }],
    })) as string;
    expect(out).toContain('commit');
    expect(out).toContain('review-pr');
    expect(out).not.toContain('private text');
  });
});
