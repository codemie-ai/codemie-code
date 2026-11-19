/**
 * `analytics view` summary: every number Connect's Analytics page shows, from report records.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary } from '../summary.js';
import { parseViewDate, readExportFile } from '../input.js';
import { DAY_MS, dispatch, payload, record, tokens, unpricedRecord } from './record-fixture.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0);
const opts = { compare: false, now: NOW };
/** 1 Nov – 19 Nov 2026, local calendar days. */
const NOV = { from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 19, 23, 59, 59, 999).getTime() };

describe('buildSummary', () => {
  it('totals match the per-session sums and the export meta for the same sessions', () => {
    const sessions = [
      record({ sessionId: 'a' }),
      record({
        sessionId: 'b', costUSD: 1.25, cacheReadCostUSD: 0.5, durationMs: 90 * 60_000, turns: 30,
        linesAdded: 100, linesRemoved: 60, netLines: 40, filesChanged: 5, toolCallsTotal: 8, toolCallsSuccess: 5,
        tokens: tokens(80_000, 100_000),
      }),
      record({ sessionId: 'c', costUSD: 0.25, turns: 1, toolCallsTotal: 0, toolCallsSuccess: 0, filesChanged: 0, netLines: 0, linesAdded: 0, linesRemoved: 0 }),
    ];

    const s = buildSummary(payload(sessions), NOV, opts);

    expect(s.schema).toBe('codemie.analytics.summary/1');
    expect(s.filter).toEqual({ agent: null, project: null, branch: null });
    expect(s.totals).toEqual({
      sessions: 3,
      pricedSessions: 3,
      costUSD: 0.5 + 1.25 + 0.25,
      cacheReadCostUSD: 0.15 + 0.5 + 0.15,
      durationMs: 30 * 60_000 + 90 * 60_000 + 30 * 60_000,
      turns: 12 + 30 + 1,
      linesAdded: 140,
      linesRemoved: 70,
      netLines: 70,
      filesChanged: 8,
      toolCalls: 18,
      // meta.totals.toolSuccessRate's own formula: a percent with one decimal
      toolSuccessRate: Math.round((14 / 18) * 1000) / 10,
      tokens: { input: 3_000, output: 6_000, cacheRead: 180_000, cacheCreation: 10_000 + 17_000 + 10_000, total: 226_000 },
    });
    expect(s.totals.toolSuccessRate).toBe(77.8);
    expect(s.sessions.map((r) => r.sessionId)).toEqual(['a', 'b', 'c']); // same start: input order kept
  });

  it('rolls up tools, skills, subagents, commands, models and projects, sorted by calls or cost', () => {
    const sonnet = (costUSD: number) => ({ model: 'claude-sonnet-4-5', tokens: tokens(), costUSD, unpriced: false });
    const sessions = [
      record({
        sessionId: 'a', costUSD: 0.5,
        tools: [
          { toolName: 'Read', totalCalls: 6, successCount: 6, failureCount: 0, successRate: 100 },
          { toolName: 'Bash', totalCalls: 4, successCount: 3, failureCount: 1, successRate: 75 },
        ],
        dispatches: [
          dispatch({ kind: 'skill', name: 'brainstorming', start: 1 }),
          dispatch({ kind: 'skill', name: 'brainstorming', start: 2 }),
          dispatch({ kind: 'agent', name: 'general-purpose', start: 3 }),
          dispatch({ kind: 'command', name: 'compact', start: 4 }),
        ],
        perModelCost: [sonnet(0.5)],
      }),
      record({
        sessionId: 'b', costUSD: 2.25, project: '/Users/taylor/projects/recipe-box', netLines: -5,
        tools: [
          { toolName: 'Read', totalCalls: 2, successCount: 2, failureCount: 0, successRate: 100 },
          { toolName: 'Edit', totalCalls: 7, successCount: 7, failureCount: 0, successRate: 100 },
        ],
        dispatches: [
          dispatch({ kind: 'skill', name: 'brainstorming', start: 1 }),
          dispatch({ kind: 'skill', name: 'writing-plans', start: 2 }),
          dispatch({ kind: 'agent', name: 'general-purpose', start: 3 }),
          dispatch({ kind: 'agent', name: 'general-purpose', start: 4 }),
          dispatch({ kind: 'agent', name: 'code-reviewer', start: 5 }),
        ],
        perModelCost: [sonnet(0.25), { model: 'claude-opus-4-1', tokens: tokens(0, 10_000), costUSD: 2, unpriced: false }],
      }),
      // Incomplete dispatches with tracked counts: the report's dispatchCounts uses the tracked counts.
      unpricedRecord({
        sessionId: 'c', tools: [], dispatchesComplete: false,
        dispatches: [dispatch({ kind: 'command', name: 'not-counted', start: 1 })],
        commandInvocations: [{ name: 'review', totalCalls: 3, successCount: 3, failureCount: 0 }],
      }),
    ];

    const s = buildSummary(payload(sessions), NOV, opts);

    expect(s.tools).toEqual([
      { name: 'Read', calls: 8, success: 8, failure: 0, successRate: 100 },
      { name: 'Edit', calls: 7, success: 7, failure: 0, successRate: 100 },
      { name: 'Bash', calls: 4, success: 3, failure: 1, successRate: 75 },
    ]);
    expect(s.skills).toEqual([
      { name: 'brainstorming', calls: 3, sessions: 2 },
      { name: 'writing-plans', calls: 1, sessions: 1 },
    ]);
    expect(s.agents).toEqual([
      { name: 'general-purpose', calls: 3, sessions: 2 },
      { name: 'code-reviewer', calls: 1, sessions: 1 },
    ]);
    expect(s.commands).toEqual([
      { name: 'review', calls: 3, sessions: 1 },
      { name: 'compact', calls: 1, sessions: 1 },
    ]);
    expect(s.models).toEqual([
      { model: 'claude-opus-4-1', costUSD: 2, tokens: 10_000, sessions: 1, share: 2 / 2.75 },
      { model: 'claude-sonnet-4-5', costUSD: 0.75, tokens: 126_000, sessions: 2, share: 0.75 / 2.75 },
    ]);
    expect(s.projects).toEqual([
      { project: '/Users/taylor/projects/recipe-box', costUSD: 2.25, sessions: 1, netLines: -5 },
      { project: '/Users/taylor/projects/garden-planner', costUSD: 0.5, sessions: 2, netLines: 60 },
    ]);
    expect(s.agentsUsed).toEqual([{ agentName: 'claude', sessions: 3, costUSD: 2.75 }]);
    expect(s.sessions.find((r) => r.sessionId === 'b')!.steps).toEqual({ agents: 3, skills: 2, commands: 0 });
    expect(s.sessions.find((r) => r.sessionId === 'c')!.steps).toEqual({ agents: 0, skills: 0, commands: 3 });
  });

  it('marks dead sessions with cost but no files and no net lines, and ranks them by cost', () => {
    const dead = Array.from({ length: 10 }, (_, i) =>
      record({ sessionId: `dead-${i}`, costUSD: (i + 1) / 10, filesChanged: 0, netLines: 0 })
    );
    const sessions = [
      ...dead,
      record({ sessionId: 'worked', costUSD: 4.5 }),
      unpricedRecord({ sessionId: 'free', filesChanged: 0, netLines: 0 }), // no cost, so not dead
    ];

    const { dead: d } = buildSummary(payload(sessions), NOV, opts).efficiency;

    const deadCost = dead.reduce((sum, r) => sum + r.costUSD, 0);
    expect(d.sessions).toBe(10);
    expect(d.costUSD).toBeCloseTo(5.5, 10);
    expect(d.shareOfCost).toBeCloseTo(deadCost / (deadCost + 4.5), 10);
    expect(d.shareOfSessions).toBe(10 / 12);
    expect(d.top).toHaveLength(8);
    expect(d.top.map((r) => r.sessionId)).toEqual(['dead-9', 'dead-8', 'dead-7', 'dead-6', 'dead-5', 'dead-4', 'dead-3', 'dead-2']);
  });

  it('computes context per turn as the report does: all cache reads over all turns', () => {
    const sessions = [
      record({ sessionId: 'a', turns: 10, tokens: tokens(1_000, 10_000), costUSD: 1, cacheReadCostUSD: 0.25 }),
      record({ sessionId: 'no-cache', turns: 90, tokens: tokens(0, 10_000) }),
      record({ sessionId: 'c', turns: 10, tokens: tokens(3_000, 10_000), costUSD: 2, cacheReadCostUSD: 1 }),
    ];

    const { efficiency } = buildSummary(payload(sessions), NOV, opts);

    expect(efficiency.contextPerTurn).toBe((1_000 + 0 + 3_000) / (10 + 90 + 10)); // the session without cache reads counts too
    expect(efficiency.heavy.map((r) => [r.sessionId, r.contextPerTurn, r.bloatPct])).toEqual([
      ['c', 300, 50],
      ['a', 100, 25],
    ]);
    expect(efficiency.cacheReadCostShare).toBeCloseTo((0.25 + 0.15 + 1) / (1 + 0.5 + 2), 10);
    expect(efficiency.costPerFileUSD).toBeCloseTo(3.5 / 9, 10);
  });

  it('puts sessions into the six depth buckets with the exact labels', () => {
    const turns = [1, 2, 5, 6, 10, 11, 25, 26, 50, 51, 300];
    const sessions = turns.map((t, i) => record({ sessionId: `s${i}`, turns: t }));

    const { depth } = buildSummary(payload(sessions), NOV, opts).efficiency;

    expect(depth.buckets).toEqual([
      { label: '1', sessions: 1 },
      { label: '2–5', sessions: 2 },
      { label: '6–10', sessions: 2 },
      { label: '11–25', sessions: 2 },
      { label: '26–50', sessions: 2 },
      { label: '51+', sessions: 2 },
    ]);
    expect(depth.median).toBe(11);
    expect(depth.average).toBe(Math.round(487 / 11));
  });

  it('uses day buckets up to 35 days and Monday weeks beyond', () => {
    const p = payload([record({ sessionId: 'a', startTime: new Date(2026, 9, 20, 10).getTime() })]);

    const days = buildSummary(p, { from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 10, 4, 23, 59, 59, 999).getTime() }, opts);
    expect(days.range.bucket).toBe('day');
    expect(days.series).toHaveLength(35);
    expect(days.series.every((b) => new Date(b.from).getHours() === 0)).toBe(true);
    expect(days.series.reduce((n, b) => n + b.sessions, 0)).toBe(1);

    const weekRange = { from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 10, 5, 23, 59, 59, 999).getTime() };
    const weeks = buildSummary(p, weekRange, opts);
    expect(weeks.range.bucket).toBe('week');
    expect(weeks.series[0].from).toBe(new Date(2026, 8, 28).getTime()); // the Monday before 1 Oct
    expect(weeks.series.every((b) => new Date(b.from).getDay() === 1 && new Date(b.from).getHours() === 0)).toBe(true);
    for (let i = 1; i < weeks.series.length; i++) {
      expect(weeks.series[i].from).toBe(weeks.series[i - 1].to + 1);
    }
    expect(weeks.series.at(-1)!.to).toBeGreaterThanOrEqual(weekRange.to);
    expect(weeks.series.find((b) => b.sessions === 1)!.from).toBe(new Date(2026, 9, 19).getTime());
  });

  it('returns zeros and empty lists for an export with no matching sessions', () => {
    for (const s of [
      buildSummary(payload([]), NOV, opts),
      buildSummary(payload([record()]), { ...NOV, agent: 'gemini' }, opts),
    ]) {
      expect(s.totals).toEqual({
        sessions: 0, pricedSessions: 0, costUSD: 0, cacheReadCostUSD: 0, durationMs: 0, turns: 0,
        linesAdded: 0, linesRemoved: 0, netLines: 0, filesChanged: 0, toolCalls: 0, toolSuccessRate: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      });
      expect([s.coverage, s.tools, s.skills, s.agents, s.commands, s.models, s.projects, s.sessions]).toEqual([[], [], [], [], [], [], [], []]);
      expect(s.series).toHaveLength(19);
      expect(s.series.every((b) => b.sessions === 0 && b.costUSD === 0 && b.tokens === 0 && b.durationMs === 0)).toBe(true);
      expect(s.efficiency).toEqual({
        costPerFileUSD: null, toolSuccessRate: 0, contextPerTurn: 0, cacheReadCostShare: 0,
        dead: { sessions: 0, costUSD: 0, shareOfCost: 0, shareOfSessions: 0, top: [] },
        depth: { buckets: ['1', '2–5', '6–10', '11–25', '26–50', '51+'].map((label) => ({ label, sessions: 0 })), median: 0, average: 0 },
        heavy: [],
      });
      expect(s.previous).toBeNull();
      expect(s.change).toBeNull();
    }
  });

  it('counts an unpriced session in sessions and coverage but not in cost or pricedSessions', () => {
    const sessions = [record({ sessionId: 'priced' }), unpricedRecord({ sessionId: 'unpriced' })];

    const s = buildSummary(payload(sessions), NOV, opts);

    expect(s.totals.sessions).toBe(2);
    expect(s.totals.pricedSessions).toBe(1);
    expect(s.totals.costUSD).toBe(0.5);
    expect(s.totals.tokens).toEqual({ input: 1_000, output: 2_000, cacheRead: 50_000, cacheCreation: 10_000, total: 63_000 });
    expect(s.coverage).toEqual([{ agentName: 'claude', sessions: 2, priced: 1, withLog: 1 }]);
  });

  describe('with an export file', () => {
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'codemie-view-summary-')); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('counts a sessionId that appears twice once, keeping the later row', () => {
      const file = join(dir, 'merged.json');
      writeFileSync(file, JSON.stringify(payload([
        record({ sessionId: 'twice', costUSD: 1, title: 'Earlier capture of a running session' }),
        record({ sessionId: 'once', costUSD: 0.5 }),
        record({ sessionId: 'twice', costUSD: 2, title: 'Later capture of the same session' }),
      ])));

      const s = buildSummary(readExportFile(file), NOV, opts);

      expect(s.totals.sessions).toBe(2);
      expect(s.totals.costUSD).toBe(2.5);
      expect(s.sessions.find((r) => r.sessionId === 'twice')!.title).toBe('Later capture of the same session');
    });
  });

  it('makes one bucket per calendar day across the DST change', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Kyiv'; // clocks go back on 25 Oct 2026: that day has 25 hours
    try {
      const range = { from: new Date(2026, 9, 20).getTime(), to: new Date(2026, 9, 30, 23, 59, 59, 999).getTime() };

      const { series } = buildSummary(payload([]), range, opts);

      const dates = series.map((b) => new Date(b.from).toLocaleDateString('en-CA'));
      expect(series).toHaveLength(11);
      expect(new Set(dates).size).toBe(11);
      expect(dates[0]).toBe('2026-10-20');
      expect(dates[10]).toBe('2026-10-30');
      expect(series.find((b) => dates[series.indexOf(b)] === '2026-10-25')!.to + 1).toBe(new Date(2026, 9, 26).getTime());
      expect(series.at(-1)!.to).toBe(range.to);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('adds previous and change only with --compare and only when the input covers the previous range', () => {
    const range = { from: Date.UTC(2026, 10, 10), to: Date.UTC(2026, 10, 19, 23, 59, 59, 999) }; // 10 days
    const sessions = [
      record({ sessionId: 'now', startTime: Date.UTC(2026, 10, 12, 9), costUSD: 2, durationMs: 60_000 }),
      record({ sessionId: 'before', startTime: Date.UTC(2026, 10, 5, 9), costUSD: 1, durationMs: 30_000 }),
      record({ sessionId: 'older', startTime: Date.UTC(2026, 9, 20, 9), costUSD: 7 }),
    ];

    const plain = buildSummary(payload(sessions), range, opts);
    expect(plain.previous).toBeNull();
    expect(plain.change).toBeNull();

    const compared = buildSummary(payload(sessions), range, { ...opts, compare: true });
    expect(compared.totals.sessions).toBe(1);
    expect(compared.previous).toMatchObject({ sessions: 1, costUSD: 1, durationMs: 30_000 });
    expect(compared.change).toEqual({ costUSD: 1, sessions: 0, durationMs: 1 });

    const notCovered = buildSummary(payload(sessions, { periodStart: '2026-11-08T00:00:00.000Z' }), range, { ...opts, compare: true });
    expect(notCovered.previous).toBeNull();
    expect(notCovered.change).toBeNull();
  });
});

describe('parseViewDate', () => {
  it('keeps the UTC-day meaning of YYYY-MM-DD and uses an ISO timestamp exactly', () => {
    expect(parseViewDate('2026-11-19', 'from')).toBe(Date.UTC(2026, 10, 19));
    expect(parseViewDate('2026-11-19', 'to')).toBe(Date.UTC(2026, 10, 19) + DAY_MS - 1);
    expect(parseViewDate('2026-11-19T00:00:00+02:00', 'from')).toBe(Date.parse('2026-11-19T00:00:00+02:00'));
    expect(parseViewDate('2026-11-19T23:59:59.999+02:00', 'to')).toBe(Date.parse('2026-11-19T23:59:59.999+02:00'));
  });

  it('rejects an impossible date', () => {
    expect(() => parseViewDate('2026-13-01', 'from')).toThrow(/Invalid --from date "2026-13-01"/);
  });
});
