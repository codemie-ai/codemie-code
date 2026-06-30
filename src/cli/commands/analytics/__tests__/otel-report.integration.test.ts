/**
 * OTEL source → existing report pipeline, end to end (no CLI/commander):
 * loadOtelSessions → aggregate → buildPayload → generateReport. Proves the OTEL
 * data produces the same HTML report with correct cost/tokens.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOtelSessions } from '../otel-loader.js';
import { AnalyticsAggregator } from '../aggregator.js';
import { buildPayload } from '../report/payload-builder.js';
import { generateReport } from '../report/report-generator.js';

const FIXTURE = join(__dirname, 'fixtures', 'otel-events.sample.jsonl');

describe('OTEL → report pipeline', () => {
  const { rawSessions, costIndex, summary } = loadOtelSessions({ file: FIXTURE });
  const keep = new Set(
    [...costIndex.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
  );
  const analytics = AnalyticsAggregator.aggregate(rawSessions, true, keep);

  it('aggregates both OTEL sessions', () => {
    expect(analytics.totalSessions).toBe(2);
  });

  it('builds a payload whose totals carry the authoritative OTEL cost', () => {
    const payload = buildPayload(analytics, costIndex, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(payload.sessions).toHaveLength(2);
    expect(payload.meta.totals.totalCostUSD).toBeCloseTo(0.0895, 6);
    const summed = payload.sessions.reduce((s, r) => s + r.costUSD, 0);
    expect(summed).toBeCloseTo(0.0895, 6);
  });

  it('carries session detail (turns, tools, dispatches, project) into the payload', () => {
    const payload = buildPayload(analytics, costIndex, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-19T00:00:00.000Z',
    });
    const main = payload.sessions.find((s) => s.sessionId.startsWith('1111'))!;
    expect(main.turns).toBe(2);
    expect(main.toolCallsTotal).toBe(4); // Edit x2, Bash, Read
    expect(main.tools.length).toBeGreaterThan(0);
    expect(main.dispatches?.length).toBe(2); // tech-analyst agent + brainstorming skill
    expect(main.project).toBe('/Users/dev/projects/codemie-code');
    expect(main.branch).toBe('feature/analytics-otel-source');
    expect(main.netLines).toBe(90); // 120 - 30
  });

  it('generates a self-contained HTML report file', () => {
    const payload = buildPayload(analytics, costIndex, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-19T00:00:00.000Z',
    });
    const out = join(mkdtempSync(join(tmpdir(), 'otel-report-')), 'report.html');
    generateReport(payload, out);
    const html = readFileSync(out, 'utf-8');
    expect(html.length).toBeGreaterThan(5000);
    expect(html.toLowerCase()).toContain('<!doctype html');
  });
});
