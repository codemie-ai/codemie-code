/**
 * Aggregator branch-attribution tests.
 *
 * Regression coverage for the bug where every branch in a project was assigned ALL of
 * the project's sessions (the `contributingSessions` filter ignored the branch), which
 * collapsed the whole project onto a single branch in the report and double-counted
 * multi-branch sessions in the terminal hierarchy.
 */

import { describe, it, expect } from 'vitest';
import { AnalyticsAggregator } from '../aggregator.js';
import type { RawSessionData } from '../data-loader.js';
import type { MetricDelta } from '../../../../agents/core/metrics/types.js';

function delta(sessionId: string, gitBranch: string, i: number): MetricDelta {
  return {
    recordId: `${sessionId}-${i}`,
    sessionId,
    agentSessionId: sessionId,
    timestamp: 1000 + i,
    gitBranch,
    tools: { Read: 1 },
    toolStatus: { Read: { success: 1, failure: 0 } },
    fileOperations: [{ type: 'edit', path: `f${i}.ts`, linesAdded: 3, linesRemoved: 1 }],
    models: ['claude-sonnet-4-6'],
    syncStatus: 'synced',
    syncAttempts: 0,
  } as MetricDelta;
}

function session(sessionId: string, cwd: string, deltas: MetricDelta[]): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: 1000,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { provider: 'native', workingDirectory: cwd, startTime: 1000 },
    },
    endEvent: {
      recordId: `${sessionId}-end`,
      type: 'session_end',
      timestamp: 2000,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { endTime: 2000, duration: 1000, totalTurns: deltas.length },
    },
    deltas,
  } as RawSessionData;
}

describe('AnalyticsAggregator branch attribution', () => {
  it('assigns each session only to the branches it contributed deltas to', () => {
    const a = session('A', '/repo', [delta('A', 'main', 0), delta('A', 'main', 1)]);
    const b = session('B', '/repo', [delta('B', 'feat/x', 0), delta('B', 'feat/x', 1)]);

    const root = AnalyticsAggregator.aggregate([a, b]);
    const project = root.projects.find((p) => p.projectPath === '/repo')!;
    const main = project.branches.find((br) => br.branchName === 'main')!;
    const feat = project.branches.find((br) => br.branchName === 'feat/x')!;

    expect(main.sessions.map((s) => s.sessionId)).toEqual(['A']);
    expect(feat.sessions.map((s) => s.sessionId)).toEqual(['B']);
    expect(main.totalSessions).toBe(1);
    expect(feat.totalSessions).toBe(1);
  });

  it('counts a multi-branch session once at the project and root level', () => {
    // A tracked session whose deltas span two branches must not be double-counted.
    const c = session('C', '/repo2', [delta('C', 'main', 0), delta('C', 'feat/y', 1)]);

    const root = AnalyticsAggregator.aggregate([c]);
    const project = root.projects.find((p) => p.projectPath === '/repo2')!;

    expect(project.branches).toHaveLength(2); // both branches still represented
    expect(project.totalSessions).toBe(1); // but the session is counted once
    expect(root.totalSessions).toBe(1);
    expect(project.totalDuration).toBe(1000); // duration counted once, not per-branch
  });

  it('excludes a session with no recorded activity (zero deltas)', () => {
    // An analytics "session" means a session that did measurable work. A started-but-empty
    // session (no turns/tools/files/cost) is noise and must not appear in the report.
    const empty = session('E', '/repo3', []);

    const root = AnalyticsAggregator.aggregate([empty]);

    expect(root.projects.find((p) => p.projectPath === '/repo3')).toBeUndefined();
    expect(root.totalSessions).toBe(0);
  });

  it('keeps a zero-delta session when it is in keepSessionIds (carries cost)', () => {
    // A tracked session with an empty metrics file but real cost from a correlated agent log
    // must NOT be dropped, or its cost vanishes from the report. The caller marks it via keep set.
    const empty = session('E', '/repo3b', []);

    const root = AnalyticsAggregator.aggregate([empty], true, new Set(['E']));
    const project = root.projects.find((p) => p.projectPath === '/repo3b')!;

    expect(project).toBeDefined();
    expect(project.totalSessions).toBe(1);
    expect(project.branches.map((b) => b.branchName)).toEqual(['Unknown']);
  });

  it('derives duration from the last activity timestamp when the session never completed', () => {
    // A session with no end event must NOT fall back to (now - start) — that inflates
    // duration to weeks/months for any session that was never marked completed.
    const start = 1_000_000;
    const raw = {
      sessionId: 'D',
      startEvent: {
        recordId: 'D',
        type: 'session_start',
        timestamp: start,
        codeMieSessionId: 'D',
        agentName: 'claude',
        syncStatus: 'synced',
        data: { provider: 'native', workingDirectory: '/repo5', startTime: start },
      },
      // no endEvent — the buggy path
      deltas: [
        { ...delta('D', 'main', 0), timestamp: start },
        { ...delta('D', 'main', 1), timestamp: start + 300_000 }, // +5 min
      ],
    } as unknown as RawSessionData;

    const root = AnalyticsAggregator.aggregate([raw]);
    const project = root.projects.find((p) => p.projectPath === '/repo5')!;

    expect(project.totalDuration).toBe(300_000); // 5 min of activity, not months
  });

  it('counts only the active session, excluding the empty one in the same project', () => {
    const active = session('A', '/repo4', [delta('A', 'main', 0)]);
    const empty = session('E', '/repo4', []);

    const root = AnalyticsAggregator.aggregate([active, empty]);
    const project = root.projects.find((p) => p.projectPath === '/repo4')!;

    expect(project.totalSessions).toBe(1); // only the active session
    expect(project.branches.map((b) => b.branchName)).toEqual(['main']); // no Unknown bucket
    expect(project.branches[0].sessions.map((s) => s.sessionId)).toEqual(['A']);
  });
});
