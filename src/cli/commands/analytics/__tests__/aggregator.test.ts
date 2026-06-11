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

describe('NamedInvocationStats — type presence', () => {
  it('SessionAnalytics carries skillInvocations, agentInvocations, commandInvocations', () => {
    const d = delta('A', 'main', 0);
    const s = session('A', '/repo', [d]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]?.branches[0]?.sessions[0];
    expect(sa).toBeDefined();
    // These field accesses fail to compile until the type is added
    expect(Array.isArray(sa!.skillInvocations)).toBe(true);
    expect(Array.isArray(sa!.agentInvocations)).toBe(true);
    expect(Array.isArray(sa!.commandInvocations)).toBe(true);
  });

  it('aggregates skillInvocations from deltas with skillInvocations', () => {
    const d1: MetricDelta = {
      recordId: 'r1', sessionId: 'A', agentSessionId: 'A',
      timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      skillInvocations: { 'tech-lead': 2, 'brainstorming': 1 },
      syncStatus: 'synced', syncAttempts: 0,
    };
    const d2: MetricDelta = {
      recordId: 'r2', sessionId: 'A', agentSessionId: 'A',
      timestamp: 1002, gitBranch: 'main',
      tools: {}, toolStatus: {},
      skillInvocations: { 'tech-lead': 1 },
      syncStatus: 'synced', syncAttempts: 0,
    };
    const s = session('A', '/repo', [d1, d2]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]!.branches[0]!.sessions[0]!;
    expect(sa.skillInvocations).toHaveLength(2);
    expect(sa.skillInvocations[0]).toEqual({ name: 'tech-lead', totalCalls: 3, successCount: 3, failureCount: 0 });
    expect(sa.skillInvocations[1]).toEqual({ name: 'brainstorming', totalCalls: 1, successCount: 1, failureCount: 0 });
  });

  it('aggregates agentInvocations from deltas with agentInvocations', () => {
    const d: MetricDelta = {
      recordId: 'r3', sessionId: 'B', agentSessionId: 'B',
      timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      agentInvocations: { 'claude': 3, 'Explore': 1 },
      syncStatus: 'synced', syncAttempts: 0,
    };
    const s = session('B', '/repo', [d]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]!.branches[0]!.sessions[0]!;
    expect(sa.agentInvocations[0]).toEqual({ name: 'claude', totalCalls: 3, successCount: 3, failureCount: 0 });
    expect(sa.agentInvocations[1]).toEqual({ name: 'Explore', totalCalls: 1, successCount: 1, failureCount: 0 });
  });

  it('aggregates commandInvocations from deltas with commandInvocations', () => {
    const d: MetricDelta = {
      recordId: 'r4', sessionId: 'C', agentSessionId: 'C',
      timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      commandInvocations: { 'analytics': 2 },
      syncStatus: 'synced', syncAttempts: 0,
    };
    const s = session('C', '/repo', [d]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]!.branches[0]!.sessions[0]!;
    expect(sa.commandInvocations[0]).toEqual({ name: 'analytics', totalCalls: 2, successCount: 2, failureCount: 0 });
  });

  it('returns empty arrays when deltas have no named invocations', () => {
    const d = delta('D', 'main', 0); // existing helper — no skill/agent/command fields
    const s = session('D', '/repo', [d]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]!.branches[0]!.sessions[0]!;
    expect(sa.skillInvocations).toEqual([]);
    expect(sa.agentInvocations).toEqual([]);
    expect(sa.commandInvocations).toEqual([]);
  });
});

describe('change metrics — filesChanged/Written/Edited', () => {
  it('counts distinct paths by op type, excluding reads', () => {
    const d: MetricDelta = {
      recordId: 'r1', sessionId: 'W', agentSessionId: 'W',
      timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      fileOperations: [
        { type: 'write', path: 'a.ts', linesAdded: 10 },
        { type: 'edit', path: 'a.ts', linesAdded: 2, linesRemoved: 1 }, // same path, also edited
        { type: 'edit', path: 'b.ts', linesAdded: 3, linesRemoved: 0 },
        { type: 'read', path: 'c.ts' }, // must NOT count toward changes
      ],
      models: ['claude-sonnet-4-6'], syncStatus: 'synced', syncAttempts: 0,
    } as MetricDelta;
    const s = session('W', '/repo', [d]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]!.branches[0]!.sessions[0]!;
    expect(sa.filesWritten).toBe(1); // a.ts
    expect(sa.filesEdited).toBe(2);  // a.ts, b.ts
    expect(sa.filesChanged).toBe(2); // a.ts (once) ∪ b.ts
  });

  it('is zero when a session only reads files', () => {
    const d: MetricDelta = {
      recordId: 'r2', sessionId: 'R', agentSessionId: 'R',
      timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      fileOperations: [{ type: 'read', path: 'a.ts' }, { type: 'glob', pattern: '*.ts' }],
      models: ['claude-sonnet-4-6'], syncStatus: 'synced', syncAttempts: 0,
    } as MetricDelta;
    const s = session('R', '/repo', [d]);
    const root = AnalyticsAggregator.aggregate([s]);
    const sa = root.projects[0]!.branches[0]!.sessions[0]!;
    expect(sa.filesChanged).toBe(0);
    expect(sa.filesWritten).toBe(0);
    expect(sa.filesEdited).toBe(0);
  });
});

describe('session title — derived from first user prompt', () => {
  function withPrompt(sessionId: string, text: string): RawSessionData {
    const d: MetricDelta = {
      recordId: `${sessionId}-0`, sessionId, agentSessionId: sessionId,
      timestamp: 1001, gitBranch: 'main', tools: {}, toolStatus: {},
      userPrompts: [{ count: 1, text }],
      syncStatus: 'synced', syncAttempts: 0,
    } as MetricDelta;
    return session(sessionId, '/repo', [d]);
  }

  it('strips command/system XML and keeps the command name + args', () => {
    const root = AnalyticsAggregator.aggregate([withPrompt('T',
      '<command-name>/pm</command-name>\n<command-args>I have the presentation of PRD</command-args>\n<system-reminder>noise that must be removed</system-reminder>')]);
    expect(root.projects[0]!.branches[0]!.sessions[0]!.title).toBe('/pm I have the presentation of PRD');
  });

  it('uses plain prompt text and collapses whitespace', () => {
    const root = AnalyticsAggregator.aggregate([withPrompt('P', "  let's ask the code review agent   to review  ")]);
    expect(root.projects[0]!.branches[0]!.sessions[0]!.title).toBe("let's ask the code review agent to review");
  });

  it('is empty when there is no user prompt', () => {
    const root = AnalyticsAggregator.aggregate([session('N', '/repo', [delta('N', 'main', 0)])]);
    expect(root.projects[0]!.branches[0]!.sessions[0]!.title).toBe('');
  });

  it('skips the local-command caveat boilerplate and uses the next real prompt', () => {
    const d: MetricDelta = {
      recordId: 'C-0', sessionId: 'C', agentSessionId: 'C', timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      userPrompts: [
        { count: 1, text: 'Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.' },
        { count: 1, text: 'add a dark mode toggle to the report' },
      ],
      syncStatus: 'synced', syncAttempts: 0,
    } as MetricDelta;
    const root = AnalyticsAggregator.aggregate([session('C', '/repo', [d])]);
    expect(root.projects[0]!.branches[0]!.sessions[0]!.title).toBe('add a dark mode toggle to the report');
  });

  it('skips an interrupted-request marker', () => {
    const d: MetricDelta = {
      recordId: 'I-0', sessionId: 'I', agentSessionId: 'I', timestamp: 1001, gitBranch: 'main',
      tools: {}, toolStatus: {},
      userPrompts: [
        { count: 1, text: '[Request interrupted by user]' },
        { count: 1, text: 'actually, refactor the enricher' },
      ],
      syncStatus: 'synced', syncAttempts: 0,
    } as MetricDelta;
    const root = AnalyticsAggregator.aggregate([session('I', '/repo', [d])]);
    expect(root.projects[0]!.branches[0]!.sessions[0]!.title).toBe('actually, refactor the enricher');
  });
});
