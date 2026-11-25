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
